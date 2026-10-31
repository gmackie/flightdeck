import type {
  CaseId,
  EventEnvelope,
  LifecycleEvent,
  RelationId,
  RelationInput,
  StageInstanceId,
  TerminalClass,
} from "./types.js";
import { id, terminalClasses } from "./types.js";

/** Explicit context supplied by the schema adapter. No business outcome/reason inference. */
export interface NormalizationContext {
  caseId?: CaseId;
  stageInstanceId?: StageInstanceId;
  interruptionId?: string;
  terminal?: TerminalClass;
  relation?: RelationInput;
  relationId?: RelationId;
}
export type NormalizationResult =
  | { event: LifecycleEvent; diagnostic: null }
  | {
      event: null;
      diagnostic: { code: "unsupported_transition" | "missing_context"; message: string };
    };

/** Workstream A's canonical past-tense names -> engine actions.
 * This maps transition semantics only, AFTER A validates the wire envelope. It deliberately
 * rejects catalog creation and correction envelopes, which require their own explicit handling.
 */
export function normalizeCanonicalTransition(
  type: string,
  envelope: EventEnvelope,
  context: NormalizationContext,
): NormalizationResult {
  const missing = (message: string): NormalizationResult => ({
    event: null,
    diagnostic: { code: "missing_context", message },
  });
  const ok = (event: LifecycleEvent): NormalizationResult => ({ event, diagnostic: null });
  switch (type) {
    case "case.started":
    case "case.reopened":
      if (!context.caseId)
        return missing("Map the canonical case ID into a scoped engine case ID.");
      return ok({
        ...envelope,
        type: type === "case.started" ? "case.start" : "case.reopen",
        caseId: context.caseId,
      });
    case "case.paused":
    case "case.resumed":
      if (!context.caseId || !context.interruptionId)
        return missing("Case interruption requires an explicit matched interruptionId and caseId.");
      return ok({
        ...envelope,
        type: type === "case.paused" ? "case.pause" : "case.resume",
        caseId: context.caseId,
        interruptionId: context.interruptionId,
      });
    case "case.completed":
    case "case.terminated": {
      if (!context.caseId)
        return missing("Map the canonical case ID into a scoped engine case ID.");
      if (
        type === "case.completed" &&
        context.terminal !== undefined &&
        context.terminal !== "completed"
      ) {
        return missing(
          "case.completed contradicts the supplied terminal context; resolve the source evidence first.",
        );
      }
      const terminal = type === "case.completed" ? "completed" : context.terminal;
      if (!terminal || !terminalClasses.includes(terminal))
        return missing(
          "case.terminated has no canonical terminal field; supply an authoritative terminal class. Never infer it from a missing event or free-form reason.",
        );
      return ok({ ...envelope, type: "case.terminate", caseId: context.caseId, terminal });
    }
    case "stage.entered":
    case "stage.exited":
    case "stage.skipped": {
      if (!context.stageInstanceId)
        return missing("Map the canonical stage instance ID, scoped to its case.");
      const action = {
        "stage.entered": "stage.enter",
        "stage.exited": "stage.exit",
        "stage.skipped": "stage.skip",
      } as const;
      return ok({ ...envelope, type: action[type], stageInstanceId: context.stageInstanceId });
    }
    case "stage.blocked":
    case "stage.unblocked":
    case "stage.paused":
    case "stage.resumed": {
      if (!context.stageInstanceId || !context.interruptionId)
        return missing(
          "Stage interruption requires an explicit matched interruptionId and stageInstanceId.",
        );
      const action = {
        "stage.blocked": "stage.block",
        "stage.unblocked": "stage.unblock",
        "stage.paused": "stage.pause",
        "stage.resumed": "stage.resume",
      } as const;
      return ok({
        ...envelope,
        type: action[type],
        stageInstanceId: context.stageInstanceId,
        interruptionId: context.interruptionId,
      });
    }
    case "object.linked":
      if (!context.relation)
        return missing("Supply an explicit stable relation ID, kind and scoped endpoints.");
      return ok({ ...envelope, type: "relation.link", relation: context.relation });
    case "object.unlinked":
      if (!context.relationId)
        return missing("Supply the same stable relation ID as the original link.");
      return ok({ ...envelope, type: "relation.unlink", relationId: context.relationId });
    default:
      return {
        event: null,
        diagnostic: {
          code: "unsupported_transition",
          message:
            "Unsupported canonical transition. case.created is catalog evidence, event.corrected needs target resolution; neither is silently treated as a lifecycle action.",
        },
      };
  }
}

/** Structural subset of Workstream A ProcessDefinitionV1; no shared-schema dependency. */
export interface CanonicalProcessDefinition {
  readonly processId: string;
  readonly version: number;
  readonly name: string;
  readonly stages: readonly {
    readonly stageId: string;
    readonly name: string;
    readonly terminal?: boolean;
  }[];
}
/** A only provides terminal=true, never an outcome. Require an explicit stage-to-class mapping. */
export function normalizeCanonicalDefinition(
  definition: CanonicalProcessDefinition,
  context: {
    processId: import("./types.js").ProcessId;
    stageIds: ReadonlyMap<string, import("./types.js").StageId>;
    terminalClasses?: ReadonlyMap<string, TerminalClass>;
  },
):
  | { definition: import("./types.js").ProcessDefinition; diagnostic: null }
  | { definition: null; diagnostic: { code: "missing_context"; message: string } } {
  const stages: import("./types.js").StageDefinition[] = [];
  for (const stage of definition.stages) {
    const stageId = context.stageIds.get(stage.stageId);
    const terminal = context.terminalClasses?.get(stage.stageId);
    if (
      !stageId ||
      (stage.terminal === true && (!terminal || !terminalClasses.includes(terminal))) ||
      (stage.terminal !== true && terminal !== undefined)
    ) {
      return {
        definition: null,
        diagnostic: {
          code: "missing_context",
          message:
            "Every canonical stage requires an explicit ID mapping; terminal flags require an authoritative terminal class, and nonterminal stages cannot be classified as terminal.",
        },
      };
    }
    stages.push({
      id: stageId,
      label: stage.name,
      ...(stage.terminal === true ? { terminal } : {}),
    });
  }
  return {
    definition: { id: context.processId, label: definition.name, stages },
    diagnostic: null,
  };
}

/** A sourceSequence is per app/case, across producer names. Preserve producer as metadata. */
export function normalizeCanonicalEnvelope(
  wire: {
    readonly eventId: string;
    readonly caseId: string;
    readonly occurredAt: number;
    readonly sourceSequence: number;
    readonly source?: string;
  },
  appId: string,
): EventEnvelope {
  return {
    id: id<"event">(JSON.stringify([appId, wire.eventId])),
    occurredAt: wire.occurredAt,
    source: {
      id: JSON.stringify([appId, wire.caseId]),
      sequence: wire.sourceSequence,
      producer: wire.source,
    },
  };
}
