export interface LiveEnv {
 PROJECT_ID?:string;
 CORE?:{liveSessions?(projectId:string):Promise<{enabled:boolean;[key:string]:unknown}>};
}
export async function handleLiveSessions(request:Request,env:LiveEnv):Promise<Response>{
 const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
 if(request.method!=="GET")return json({error:"method_not_allowed"},405);
 if(!env.PROJECT_ID||!env.CORE?.liveSessions)return json({error:"live_sessions_not_configured"},503);
 try{
  const result=await env.CORE.liveSessions(env.PROJECT_ID);
  if(!result.enabled)return json({error:"live_sessions_not_configured"},503);
  return json(result);
 }catch{return json({error:"live_sessions_unavailable"},503);}
}
