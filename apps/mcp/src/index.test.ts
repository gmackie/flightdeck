import {describe,expect,it} from "vitest";
import server from "./index";
describe("Flightdeck MCP security",()=>{
  it("does not expose any MCP tools without Access configuration",async()=>{
    const response=await server.fetch(new Request("https://agent.example/mcp",{method:"POST"}),{
      ACCESS_TEAM_DOMAIN:"",ACCESS_AUD:"",
      CONSOLE:{fetch:async()=>new Response("unexpected")} as unknown as Fetcher
    },{} as ExecutionContext);
    expect(response.status).toBe(401);
  });
  it("keeps unrelated routes unconfigured",async()=>{
    const response=await server.fetch(new Request("https://agent.example/"),{
      ACCESS_TEAM_DOMAIN:"",ACCESS_AUD:"",
      CONSOLE:{fetch:async()=>new Response("unexpected")} as unknown as Fetcher
    },{} as ExecutionContext);
    expect(response.status).toBe(404);
  });
});
