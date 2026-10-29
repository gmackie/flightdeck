import {it,expect,vi} from "vitest";
import {handleLiveSessions} from "./live";
it("uses the configured project and ignores caller-supplied project identities",async()=>{
 const liveSessions=vi.fn(async()=>({enabled:true,sessions:[]}));
 const response=await handleLiveSessions(new Request("https://console/api/live-sessions?projectId=other"),{PROJECT_ID:"owned",CORE:{liveSessions}});
 expect(response.status).toBe(200);expect(liveSessions).toHaveBeenCalledWith("owned");expect(response.headers.get("Cache-Control")).toBe("no-store");
});
it("fails closed for missing live bindings and hides private errors",async()=>{
 const req=new Request("https://console/api/live-sessions");
 expect((await handleLiveSessions(req,{})).status).toBe(503);
 expect((await handleLiveSessions(req,{PROJECT_ID:"p",CORE:{liveSessions:async()=>({enabled:false})}})).status).toBe(503);
 const response=await handleLiveSessions(req,{PROJECT_ID:"p",CORE:{liveSessions:async()=>{throw new Error("private details");}}});
 expect(response.status).toBe(503);expect(await response.text()).not.toContain("private details");
 expect((await handleLiveSessions(new Request(req,{method:"POST"}),{})).status).toBe(405);
});
