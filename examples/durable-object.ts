import { DurableObject } from "cloudflare:workers";
import { createFlightdeck } from "@flightdeck/sdk-worker";
import type { AnalyticsBinding } from "@flightdeck/contracts";

type Env={
  FLIGHTDECK:AnalyticsBinding;
  FLIGHTDECK_SOURCE_ID:string;
  FLIGHTDECK_SOURCE_TOKEN:string;
};
/** Caller Worker authenticates and authorizes user *before* invoking this DO. */
export class ProjectSession extends DurableObject<Env> {
  async projectOpened(actorId:string,projectId:string):Promise<void>{
    const analytics=createFlightdeck({binding:this.env.FLIGHTDECK,
      sourceId:this.env.FLIGHTDECK_SOURCE_ID,sourceToken:this.env.FLIGHTDECK_SOURCE_TOKEN});
    await analytics.track("project.opened",{},{
      actorId,objects:[{type:"project",id:projectId,role:"target"}],
    });
  }
}
