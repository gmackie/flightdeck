import {describe,it,expect} from "vitest";
import {consoleHealth} from "./health";

describe("authenticated console component health",()=>{
  it("fails without real component bindings",async()=>{
    const response=await consoleHealth({});
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ok:false,eventPathVerified:false});
  });
  it("does not leak provider errors",async()=>{
    const response=await consoleHealth({CORE:{status:async()=>{throw new Error("private upstream detail");}}});
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private upstream detail");
  });
});
