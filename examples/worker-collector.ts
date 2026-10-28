import { createFlightdeck } from "@flightdeck/sdk-worker";
import { createBrowserEventHandler } from "@flightdeck/sdk-worker/handler";
import type { AnalyticsBinding } from "@flightdeck/contracts";

interface Env {
  FLIGHTDECK:AnalyticsBinding;
  FLIGHTDECK_SOURCE_ID:string;
  FLIGHTDECK_SOURCE_TOKEN:string;
}
type User={id:string};
/** Replace with your app's real authentication. No Flightdeck auth middleware required. */
declare function authenticate(request:Request, env:Env):Promise<User|null>;

export default {
  async fetch(request:Request,env:Env):Promise<Response>{
    const handler=createBrowserEventHandler({
      authenticate:(req)=>authenticate(req,env),
      client:()=>createFlightdeck({binding:env.FLIGHTDECK,sourceId:env.FLIGHTDECK_SOURCE_ID,
        sourceToken:env.FLIGHTDECK_SOURCE_TOKEN}),
      policy:{
        origins:[new URL(request.url).origin],
        events:{
          "page.viewed":{properties:["route"]},
          "project.opened":{properties:["template"]},
          "rum.lcp":{kind:"rum",properties:["value","rating"]},
        },
      },
    });
    if(new URL(request.url).pathname==="/api/analytics")return handler(request);
    const user=await authenticate(request,env);
    if(!user)return new Response("Unauthorized",{status:401});
    const fd=createFlightdeck({binding:env.FLIGHTDECK,sourceId:env.FLIGHTDECK_SOURCE_ID,
      sourceToken:env.FLIGHTDECK_SOURCE_TOKEN}).withContext({actorId:user.id});
    await fd.track("page.viewed",{route:new URL(request.url).pathname});
    return new Response("OK");
  },
};
