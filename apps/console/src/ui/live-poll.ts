/** One request at a time; hidden pages abort work and resume immediately on return. */
export function startLivePolling({load,onValue,onError,onVisibility,visibility=document,interval=2000}:{
 load:(signal:AbortSignal)=>Promise<unknown>;
 onValue:(value:unknown)=>void;
 onError:(error:unknown)=>void;
 onVisibility:(visible:boolean)=>void;
 visibility:Pick<Document,"hidden"|"addEventListener"|"removeEventListener">;
 interval?:number;
}){
 let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,controller:AbortController|undefined;
 const clear=()=>{clearTimeout(timer);controller?.abort();controller=undefined;};
 async function run(){
  if(stopped||visibility.hidden)return;
  const current=new AbortController();controller=current;
  // A hung request must not freeze future updates indefinitely.
  const timeout=setTimeout(()=>current.abort(),15_000);
  try{
   const value=await load(current.signal);
   if(!stopped&&!current.signal.aborted)onValue(value);
  }catch(error){if(!stopped&&controller===current&&!visibility.hidden)onError(error);}
  finally{
   clearTimeout(timeout);
   if(controller===current){controller=undefined;if(!stopped&&!visibility.hidden)timer=setTimeout(()=>void run(),interval);}
  }
 }
 const changed=()=>{clear();onVisibility(!visibility.hidden);if(!visibility.hidden)void run();};
 visibility.addEventListener("visibilitychange",changed);
 changed();
 return ()=>{stopped=true;clear();visibility.removeEventListener("visibilitychange",changed);};
}
