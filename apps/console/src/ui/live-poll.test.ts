import {it,expect,vi,afterEach} from "vitest";
import {startLivePolling} from "./live-poll";
function visibility(){return Object.assign(new EventTarget(),{hidden:false});}
afterEach(()=>vi.useRealTimers());
it("serializes requests and stops on cleanup",async()=>{
 vi.useFakeTimers();const page=visibility(),onValue=vi.fn();let resolve!:(v:unknown)=>void;
 const load=vi.fn(()=>new Promise(r=>{resolve=r;}));
 const stop=startLivePolling({visibility:page,load,onValue,onError:vi.fn(),onVisibility:vi.fn()});
 await vi.advanceTimersByTimeAsync(5000);expect(load).toHaveBeenCalledOnce();
 resolve({sessions:[]});await vi.advanceTimersByTimeAsync(0);expect(onValue).toHaveBeenCalledOnce();
 await vi.advanceTimersByTimeAsync(2000);expect(load).toHaveBeenCalledTimes(2);
 stop();resolve({sessions:[1]});await vi.advanceTimersByTimeAsync(10000);expect(onValue).toHaveBeenCalledOnce();expect(load).toHaveBeenCalledTimes(2);
});
it("aborts when hidden, resumes immediately, and retries errors",async()=>{
 vi.useFakeTimers();const page=visibility(),error=vi.fn(),onValue=vi.fn();const signals:AbortSignal[]=[];
 const load=vi.fn(async(signal:AbortSignal)=>{signals.push(signal);if(signals.length===1)throw new Error("offline");return {sessions:[]};});
 const stop=startLivePolling({visibility:page,load,onValue,onError:error,onVisibility:vi.fn()});
 await vi.advanceTimersByTimeAsync(0);expect(error).toHaveBeenCalledOnce();
 page.hidden=true;page.dispatchEvent(new Event("visibilitychange"));
 await vi.advanceTimersByTimeAsync(10000);expect(load).toHaveBeenCalledOnce();
 page.hidden=false;page.dispatchEvent(new Event("visibilitychange"));
 await vi.advanceTimersByTimeAsync(0);expect(load).toHaveBeenCalledTimes(2);expect(onValue).toHaveBeenCalledOnce();stop();
});

it("discards a hidden request even if it completes after the tab resumes",async()=>{
 vi.useFakeTimers();const page=visibility(),onValue=vi.fn();const pending:Array<{signal:AbortSignal;resolve:(v:unknown)=>void}>=[];
 const load=(signal:AbortSignal)=>new Promise(resolve=>{pending.push({signal,resolve});});
 const stop=startLivePolling({visibility:page,load,onValue,onError:vi.fn(),onVisibility:vi.fn()});
 page.hidden=true;page.dispatchEvent(new Event("visibilitychange"));expect(pending[0]!.signal.aborted).toBe(true);
 page.hidden=false;page.dispatchEvent(new Event("visibilitychange"));
 pending[0]!.resolve("stale");pending[1]!.resolve("fresh");await vi.advanceTimersByTimeAsync(0);
 expect(onValue).toHaveBeenCalledExactlyOnceWith("fresh");stop();
});
