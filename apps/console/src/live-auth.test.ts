import {it,expect,vi} from "vitest";
vi.mock("jose",()=>({createRemoteJWKSet:vi.fn(),jwtVerify:async(token:string)=>{
 if(token!=="verified")throw new Error("invalid signature");
 return {payload:{sub:"user",email:"reader@example.com"}};
}}));
import consoleWorker from "./index";
it("requires verified Access before reading the private live projection",async()=>{
 const liveSessions=vi.fn(async()=>({enabled:true,sessions:[]}));
 const env={ACCESS_TEAM_DOMAIN:"team.cloudflareaccess.com",ACCESS_AUD:"aud",PROJECT_ID:"owned",CORE:{liveSessions}} as any;
 for(const token of [undefined,"forged"]){
  const response=await consoleWorker.fetch(new Request("https://console/api/live-sessions",{headers:token?{"Cf-Access-Jwt-Assertion":token}:{}}),env);
  expect(response.status).toBe(401);
 }
 expect(liveSessions).not.toHaveBeenCalled();
 const response=await consoleWorker.fetch(new Request("https://console/api/live-sessions?projectId=other",{headers:{"Cf-Access-Jwt-Assertion":"verified"}}),env);
 expect(response.status).toBe(200);expect(liveSessions).toHaveBeenCalledWith("owned");
});
