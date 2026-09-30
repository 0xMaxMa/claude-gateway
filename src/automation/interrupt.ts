/** Supersede reasoning promptly; never abort a dispatched mutation through this signal. */
export function checkInterruption(signal?:AbortSignal):void {
 if(signal?.aborted)throw Error('REVISION_SUPERSEDED');
}
export async function interruptible<T>(operation:(signal:AbortSignal)=>Promise<T>,signal:AbortSignal,interrupt?:AbortSignal):Promise<T>{
 checkInterruption(interrupt);signal.throwIfAborted();
 const combined=interrupt?AbortSignal.any([signal,interrupt]):signal;
 let stop=()=>{};
 try{return await Promise.race([
  Promise.resolve().then(()=>{checkInterruption(interrupt);return operation(combined);}),
  new Promise<never>((_,reject)=>{stop=()=>reject(Error(interrupt?.aborted?'REVISION_SUPERSEDED':'TASK_CANCELLED'));combined.addEventListener('abort',stop,{once:true});if(combined.aborted)stop();})
 ]);}finally{combined.removeEventListener('abort',stop);}
}
