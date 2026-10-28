/**
 * Fixed, project-scoped analytics DSL. No arbitrary SQL or caller-controlled
 * table/project identifiers are allowed at the HTTP boundary.
 *
 * We preserve the append-only Basin event log but deduplicate logical event
 * identities at query time (per project, source, event ID). Longer-term
 * production datasets should materialize this projection to lower scan cost.
 */
export type QueryKind =
  "overview" | "top-events" | "trends" | "recent-events" | "funnel" |
  "retention" | "rum" | "experiments" | "transitions" | "experiment-analysis";
export interface QuerySpec {
  kind: QueryKind;
  from: string;
  to: string;
  limit?: number;
  eventName?: string;
  steps?: readonly string[];
  flagKey?: string;
  goalEvent?: string;
  controlVariant?: string;
  treatmentVariant?: string;
}
export interface QueryContext { projectId: string; table: string }
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const eventName = /^[a-z][a-z0-9_.-]{0,127}$/;
const project = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const kinds: readonly QueryKind[] = [
  "overview","top-events","trends","recent-events","funnel","retention","rum","experiments","transitions","experiment-analysis",
];
const expensive = new Set<QueryKind>(["funnel","retention","transitions","rum","experiment-analysis"]);
const millisPerDay = 86_400_000;
const quote = (value:string):string => "'" + value.replaceAll("'","''") + "'";
export class QueryError extends Error {
  constructor(readonly code: string) { super(code); this.name = "QueryError"; }
}
export function validateQuery(spec:QuerySpec,ctx:QueryContext,now=Date.now()):void {
  if (!project.test(ctx.projectId) ||
    ctx.table.split(".").length!==2 ||
    !ctx.table.split(".").every(x=>identifier.test(x)))
    throw new QueryError("invalid_query_context");
  if (!kinds.includes(spec.kind)) throw new QueryError("unknown_query_kind");
  const from=Date.parse(spec.from),to=Date.parse(spec.to);
  if (!Number.isFinite(from)||!Number.isFinite(to)||from>=to||to>now+millisPerDay)
    throw new QueryError("invalid_time_range");
  const maxDays=expensive.has(spec.kind)?31:90;
  if (to-from>maxDays*millisPerDay) throw new QueryError("range_exceeds_budget");
  if (spec.limit!==undefined &&
    (!Number.isInteger(spec.limit)||spec.limit<1||spec.limit>200))
    throw new QueryError("invalid_limit");
  if (spec.eventName!==undefined&&!eventName.test(spec.eventName))
    throw new QueryError("invalid_event_name");
  if (spec.kind==="funnel" &&
    (!Array.isArray(spec.steps)||spec.steps.length<2||spec.steps.length>5||
      !spec.steps.every(x=>eventName.test(x))))
    throw new QueryError("invalid_funnel_steps");
  if(spec.kind==="experiment-analysis"&&(
    typeof spec.flagKey!=="string"||!eventName.test(spec.flagKey)||
    typeof spec.goalEvent!=="string"||!eventName.test(spec.goalEvent)||
    typeof spec.controlVariant!=="string"||!/^[A-Za-z0-9_-]{1,60}$/.test(spec.controlVariant)||
    typeof spec.treatmentVariant!=="string"||!/^[A-Za-z0-9_-]{1,60}$/.test(spec.treatmentVariant)||
    spec.controlVariant===spec.treatmentVariant
  ))throw new QueryError("invalid_experiment_query");
}
/** Relative query cost—not a measurement of Cloudflare billing or bytes read. */
export function estimateQueryUnits(spec:QuerySpec):number {
  const days=Math.ceil((Date.parse(spec.to)-Date.parse(spec.from))/millisPerDay);
  const weight:Record<QueryKind,number>={
    overview:1,"top-events":2,trends:2,"recent-events":1,funnel:8,
    retention:12,rum:4,experiments:3,transitions:10,"experiment-analysis":15,
  };
  const steps=spec.kind==="funnel"?(spec.steps?.length??1):1;
  return Math.max(1,days)*weight[spec.kind]*steps;
}
function canonicalEvents(ctx:QueryContext,from:string,to:string):string {
  return `unique_events AS (
    SELECT * FROM (
      SELECT *,
        ROW_NUMBER() OVER (
          PARTITION BY project_id, source_id, event_id
          ORDER BY received_at ASC, event_id ASC
        ) AS __fd_row
      FROM ${ctx.table}
      WHERE project_id = ${quote(ctx.projectId)}
        AND occurred_at >= ${quote(new Date(from).toISOString())}
        AND occurred_at < ${quote(new Date(to).toISOString())}
    ) WHERE __fd_row = 1
  )`;
}
export function compileQuery(spec:QuerySpec,ctx:QueryContext,now=Date.now()):string {
  validateQuery(spec,ctx,now);
  const base=canonicalEvents(ctx,spec.from,spec.to);
  const table="unique_events";
  const limit=spec.limit??50;
  switch(spec.kind) {
    case "overview":
      return `WITH ${base} SELECT COUNT(*) AS events,
        approx_distinct(NULLIF(actor_id, '')) AS actors,
        approx_distinct(NULLIF(session_id, '')) AS sessions
        FROM ${table} LIMIT 1`;
    case "top-events":
      return `WITH ${base} SELECT event_name, COUNT(*) AS events FROM ${table}
        GROUP BY event_name ORDER BY events DESC LIMIT ${limit}`;
    case "trends":
      return `WITH ${base} SELECT substr(occurred_at,1,10) AS day,
        COUNT(*) AS events FROM ${table}
        GROUP BY day ORDER BY day ASC LIMIT 91`;
    case "recent-events":
      return `WITH ${base} SELECT event_id, event_name, event_kind,
        occurred_at, actor_id, session_id, properties_json, objects_json, source_id
        FROM ${table}${spec.eventName?` WHERE event_name = ${quote(spec.eventName)}`:""}
        ORDER BY occurred_at DESC LIMIT ${limit}`;
    case "rum":
      return `WITH ${base} SELECT event_name, COUNT(*) AS samples,
        approx_percentile_cont(json_get_float(properties_json, 'value'), 0.75) AS p75
        FROM ${table} WHERE event_kind = 'rum'
        GROUP BY event_name ORDER BY samples DESC LIMIT ${limit}`;
    case "experiments":
      return `WITH ${base} SELECT
        json_get_str(properties_json, 'flagKey') AS flag_key,
        json_get_str(properties_json, 'variant') AS variant,
        COUNT(*) AS exposures,
        approx_distinct(NULLIF(actor_id,'')) AS exposed_actors
        FROM ${table} WHERE event_name = 'feature.exposed'
        GROUP BY flag_key, variant ORDER BY exposures DESC LIMIT ${limit}`;
    case "transitions":
      return `WITH ${base}, ordered AS (
        SELECT actor_id, event_name,
          LEAD(event_name) OVER (
            PARTITION BY actor_id ORDER BY occurred_at, event_id
          ) AS next_event
        FROM ${table} WHERE actor_id <> ''
      )
      SELECT event_name AS from_event, next_event AS to_event,
        COUNT(*) AS transitions FROM ordered WHERE next_event IS NOT NULL
      GROUP BY event_name,next_event ORDER BY transitions DESC LIMIT ${limit}`;
    case "retention":
      return `WITH ${base},
        cohort AS (SELECT actor_id, MIN(substr(occurred_at,1,10)) AS cohort_day
          FROM ${table} WHERE actor_id <> '' GROUP BY actor_id),
        activity AS (SELECT DISTINCT actor_id,substr(occurred_at,1,10) AS active_day
          FROM ${table} WHERE actor_id <> '')
        SELECT cohort.cohort_day, activity.active_day,
          COUNT(*) AS retained FROM cohort
        INNER JOIN activity ON cohort.actor_id=activity.actor_id
        WHERE activity.active_day>=cohort.cohort_day
        GROUP BY cohort.cohort_day,activity.active_day
        ORDER BY cohort.cohort_day,activity.active_day LIMIT 200`;
    case "experiment-analysis": {
      const flag=quote(spec.flagKey!),goal=quote(spec.goalEvent!);
      const control=quote(spec.controlVariant!),treatment=quote(spec.treatmentVariant!);
      return `WITH ${base},
        raw_exposures AS (
          SELECT actor_id, occurred_at AS exposed_at,
            json_get_str(properties_json,'variant') AS variant,
            ROW_NUMBER() OVER (
              PARTITION BY actor_id ORDER BY occurred_at,event_id
            ) AS exposure_rank
          FROM ${table}
          WHERE event_name='feature.exposed'
            AND json_get_str(properties_json,'flagKey')=${flag}
            AND actor_id <> ''
        ),
        exposures AS (
          SELECT actor_id,variant,exposed_at FROM raw_exposures
          WHERE exposure_rank=1 AND variant IN (${control},${treatment})
        ),
        completed AS (
          SELECT x.actor_id, MIN(e.occurred_at) AS goal_at
          FROM exposures x
          JOIN ${table} e ON e.actor_id=x.actor_id
          WHERE e.event_name=${goal} AND e.occurred_at>x.exposed_at
          GROUP BY x.actor_id
        )
        SELECT x.variant, COUNT(*) AS exposed,
          COUNT(c.actor_id) AS converted
        FROM exposures x LEFT JOIN completed c ON x.actor_id=c.actor_id
        GROUP BY x.variant
        ORDER BY x.variant`;
    }
    case "funnel": {
      const steps=spec.steps!;
      const ctes=[base];
      for(let i=0;i<steps.length;i++){
        if(i===0){
          ctes.push(`step_0 AS (SELECT actor_id,MIN(occurred_at) AS time
            FROM ${table} WHERE event_name = ${quote(steps[i]!)}
            AND actor_id <> '' GROUP BY actor_id)`);
        }else{
          ctes.push(`step_${i} AS (
            SELECT prev.actor_id, MIN(e.occurred_at) AS time
            FROM step_${i-1} prev INNER JOIN ${table} e
            ON e.actor_id = prev.actor_id
            WHERE e.event_name = ${quote(steps[i]!)}
              AND e.occurred_at > prev.time
            GROUP BY prev.actor_id)`);
        }
      }
      const selects=steps.map((step,i)=>
        `SELECT ${i} AS step_index, ${quote(step)} AS event_name,
          COUNT(*) AS actors FROM step_${i}`);
      return `WITH ${ctes.join(",\n")} ${selects.join(" UNION ALL ")}`;
    }
  }
}
