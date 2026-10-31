import { DEMO_SNAPSHOT } from "./fixtures";
import { flattenNodes, stageTimeProblem, type WorkflowSnapshot } from "./model";

/** Replace this boundary with an API-to-view-model mapper when that API is available. */
export interface WorkflowDataAdapter {
  read(): WorkflowSnapshot;
}

/** Run on adapter output before rendering. Preserve the source and surface invalid samples. */
export function diagnoseWorkflowSnapshot(snapshot: WorkflowSnapshot) {
  return snapshot.portfolios.flatMap((portfolio) =>
    flattenNodes(portfolio.roots).flatMap((node) =>
      node.stages.flatMap((stage) => {
        const message = stageTimeProblem(stage, snapshot.asOf);
        return message
          ? [
              {
                portfolioId: portfolio.id,
                nodeId: node.id,
                stageId: stage.id,
                nodeLabel: node.label,
                stageLabel: stage.label,
                message,
              },
            ]
          : [];
      }),
    ),
  );
}

export const demoWorkflowAdapter: WorkflowDataAdapter = {
  read: () => DEMO_SNAPSHOT,
};
