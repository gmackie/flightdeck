import {describe,expect,it,vi} from "vitest";
import {sourceRegistry} from "./registry";
const token="a".repeat(64);
describe("D1 source registry",()=>{
 it("loads only a registered project-bound source",async()=>{
  const db={
    prepare:vi.fn(()=>({bind:()=>({first:async()=>({
      id:"consumer",project_id:"school",enabled:1,token_sha256:token,
      rotating_sha256_json:"[]",version:1,
      policy_json:JSON.stringify({allowedEvents:["page.viewed"],allowedProperties:{"page.viewed":["route"]}})
    })})}))
  } as unknown as D1Database;
  const r=await sourceRegistry({SOURCE_REGISTRY_MODE:"d1",META:db},"consumer");
  expect(r.consumer.projectId).toBe("school");
  expect(r.consumer.sha256).toBe(token);
  expect(db.prepare).toHaveBeenCalledOnce();
 });
 it("refuses unknown or disabled sources without falling back to secret registry",async()=>{
  const db={
    prepare:()=>({bind:()=>({first:async()=>null})})
  } as unknown as D1Database;
  await expect(sourceRegistry({SOURCE_REGISTRY_MODE:"d1",META:db,
    SOURCE_CREDENTIALS:JSON.stringify({consumer:{projectId:"wrong"}})},"consumer"))
    .rejects.toThrow("unauthorized_source");
  await expect(sourceRegistry({SOURCE_REGISTRY_MODE:"d1"},"consumer"))
    .rejects.toThrow("metadata_not_configured");
 });
});
