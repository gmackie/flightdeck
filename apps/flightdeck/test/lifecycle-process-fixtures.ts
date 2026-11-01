import { env } from "cloudflare:workers";
import { registerDefinition } from "../src/processes";

/** The `deploy@1` process the lifecycle tests' events conform to. */
export const DEPLOY_PROCESS = {
  schemaVersion: 1,
  processId: "deploy",
  version: 1,
  name: "Deploy",
  caseType: "deploy",
  stages: [
    { stageId: "build", name: "Build" },
    { stageId: "canary", name: "Canary" },
    { stageId: "done", name: "Done", terminal: true },
  ],
  dimensions: [{ key: "region", values: ["us-east", "eu-west"] }],
  relations: [
    { type: "built_from", objectType: "commit" },
    { type: "ships", objectType: "pull_request" },
  ],
};

export async function registerDeploy(appId: string): Promise<void> {
  const result = await registerDefinition(env.DB, appId, DEPLOY_PROCESS);
  if (result.status !== "created" && result.status !== "unchanged") {
    throw new Error(`could not register deploy@1 for ${appId}: ${result.status}`);
  }
}
