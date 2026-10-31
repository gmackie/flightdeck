import { DEMO_SNAPSHOT } from "./fixtures";
import type { WorkflowSnapshot } from "./model";

/** Replace this boundary with an API-to-view-model mapper when that API is available. */
export interface WorkflowDataAdapter {
  read(): WorkflowSnapshot;
}

export const demoWorkflowAdapter: WorkflowDataAdapter = {
  read: () => DEMO_SNAPSHOT,
};
