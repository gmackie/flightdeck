/**
 * A bounded analytics DSL. This module never accepts browser-authored SQL.
 * Project ID and table name must come from trusted server configuration.
 */
export type QueryKind =
  "overview"|"top-events"|"trends"|"recent-events"|"funnel"|"retention"|"rum"|"experiments"|"transitions";
export interface QuerySpec {
  kind:QueryKind;
  from:string;
  to:string;
  limit?:number;
  eventName?:string;
  steps?:readonly string[];
}
export interface QueryContext {projectId:string; table:string}
const ident=/^[A-Za-z_][A-Za-z0-9_]*$/;
const name=/^[a-z][a-z0-9_.-]{0,127}$/;
const project=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const literal=(s:string)=>"'"+s.replaceAll("'","''")+"'";
export class QueryError extends Error {
  constructor(readonly code:string){super(code);}
}
export function validateQuery(spec:QuerySpec,ctx:QueryContext,now=Date.now()):void {
  if(!project.test(ctx.projectId)||!ctx.table.split(".").every(x=>ident.test(x))||ctx.table.split(".").length!==2)
    throw new QueryError("invalid_query_context");
  if(!["overview","top-events","trends","recent-events","funnel","retention","rum","experiments","transitions"].includes(spec.kind))
    throw new QueryError("unknown_query_kind");
  const from=Date.parse(spec.from),to=Date.parse(spec.to);
  if(!Number.isFinite(from)||!Number.isFinite(to)||from>=to||to-from>90*86_400_000||to>now+86_400_000)
    throw new QueryError("invalid_time_range");
  if(spec.limit!==undefined&&(!Number.isInteger(spec.limit)||spec.limit<1||spec.limit>200))
    throw new QueryError("invalid_limit");
  if(spec.eventName!==undefined&&!name.test(spec.eventName))throw new QueryError("invalid_event_name");
  if(spec.kind==="funnel"&&(!Array.isArray(spec.steps)||spec.steps.length<2||spec.steps.length>5||
    !spec.steps.every(x=>name.test(x))))throw new QueryError("invalid_funnel_steps");
}
export function compileQuery(spec:QuerySpec,ctx:QueryContext,now=Date.now()):string {
  validateQuery(spec,ctx,now);
  const table=ctx.table;
  const filter=`project_id = ${literal(ctx.projectId)} AND occurred_at >= ${literal(new Date(spec.from).toISOString())} AND occurred_at < ${literal(new Date(spec.to).toISOString())}`;
  const limit=spec.limit??50;
  switch(spec.kind){
    case "overview":return `SELECT COUNT(*) AS events, approx_distinct(NULLIF(actor_id, '')) AS actors, approx_distinct(NULLIF(session_id, '')) AS sessions FROM ${table} WHERE ${filter} LIMIT 1`;
    case "top-events":return `SELECT event_name, COUNT(*) AS events FROM ${table} WHERE ${filter} GROUP BY event_name ORDER BY events DESC LIMIT ${limit}`;
    case "trends":return `SELECT substr(occurred_at, 1, 10) AS day, COUNT(*) AS events FROM ${table} WHERE ${filter} GROUP BY day ORDER BY day ASC LIMIT 91`;
    case "recent-events":return `SELECT event_id, event_name, event_kind, occurred_at, actor_id, session_id, properties_json, objects_json, source_id FROM ${table} WHERE ${filter}${spec.eventName?` AND event_name = ${literal(spec.eventName)}`:""} ORDER BY occurred_at DESC LIMIT ${limit}`;
    case "rum":return `SELECT event_name, COUNT(*) AS samples, approx_percentile_cont(json_get_float(properties_json, 'value'), 0.75) AS p75 FROM ${table} WHERE ${filter} AND event_kind = 'rum' GROUP BY event_name ORDER BY samples DESC LIMIT ${limit}`;
    case "experiments":return `SELECT json_get_str(properties_json, 'flagKey') AS flag_key, json_get_str(properties_json, 'variant') AS variant, COUNT(*) AS exposures FROM ${table} WHERE ${filter} AND event_name = 'feature.exposed' GROUP BY flag_key, variant ORDER BY exposures DESC LIMIT ${limit}`;
    case "transitions":return `WITH ordered AS (SELECT actor_id, event_name, LEAD(event_name) OVER (PARTITION BY actor_id ORDER BY occurred_at, event_id) AS next_event FROM ${table} WHERE ${filter} AND actor_id <> '') SELECT event_name AS from_event, next_event AS to_event, COUNT(*) AS transitions FROM ordered WHERE next_event IS NOT NULL GROUP BY event_name, next_event ORDER BY transitions DESC LIMIT ${limit}`;
    case "retention":return `WITH cohort AS (SELECT actor_id, MIN(substr(occurred_at, 1, 10)) AS cohort_day FROM ${table} WHERE ${filter} AND actor_id <> '' GROUP BY actor_id), activity AS (SELECT DISTINCT actor_id, substr(occurred_at, 1, 10) AS active_day FROM ${table} WHERE ${filter} AND actor_id <> '') SELECT cohort.cohort_day, activity.active_day, COUNT(*) AS retained FROM cohort INNER JOIN activity ON cohort.actor_id = activity.actor_id WHERE activity.active_day >= cohort.cohort_day GROUP BY cohort.cohort_day, activity.active_day ORDER BY cohort.cohort_day ASC, activity.active_day ASC LIMIT 200`;
    case "funnel": {
      const steps=spec.steps!;
      const ctes:string[]=[];
      for(let i=0;i<steps.length;i++){
        const curr=`step_${i}`;
        if(i===0){
          ctes.push(`${curr} AS (SELECT actor_id, MIN(occurred_at) AS time FROM ${table} WHERE ${filter} AND event_name = ${literal(steps[i]!)} AND actor_id <> '' GROUP BY actor_id)`);
        }else{
          ctes.push(`${curr} AS (SELECT prev.actor_id, MIN(e.occurred_at) AS time FROM step_${i-1} prev INNER JOIN ${table} e ON e.actor_id = prev.actor_id WHERE e.project_id = ${literal(ctx.projectId)} AND e.event_name = ${literal(steps[i]!)} AND e.occurred_at >= prev.time AND e.occurred_at < ${literal(new Date(spec.to).toISOString())} GROUP BY prev.actor_id)`);
        }
      }
      const selects=steps.map((event,i)=>`SELECT ${i} AS step_index, ${literal(event)} AS event_name, COUNT(*) AS actors FROM step_${i}`);
      return `WITH ${ctes.join(", ")} ${selects.join(" UNION ALL ")}`;
    }
  }
}
