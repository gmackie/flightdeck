import {it,expect,vi} from "vitest";
import {withLiveSink} from "./live-sink";
it("does not publish when canonical persistence fails",async()=>{
 const publish=vi.fn();
 const sink=withLiveSink({durability:"stream_ingested",write:async()=>{throw new Error("offline");}},publish,vi.fn());
 await expect(sink.write([])).rejects.toThrow("offline");expect(publish).not.toHaveBeenCalled();
});
it("preserves accepted history when the optional live projection fails",async()=>{
 const order:string[]=[],error=vi.fn();
 const sink=withLiveSink({durability:"stream_ingested",write:async()=>{order.push("history");}},async()=>{order.push("live");throw new Error("unavailable");},error);
 await sink.write([]);expect(order).toEqual(["history","live"]);expect(error).toHaveBeenCalledOnce();expect(sink.durability).toBe("stream_ingested");
});
