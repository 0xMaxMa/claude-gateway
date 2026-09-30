'use strict';
/** No domain, credentials, filesystem, subprocesses or automatic mutation retries. */
class LoopError extends Error {
  constructor(code) { super(code); this.name='LoopError'; this.code=code; }
}
async function bounded(operation, signal, timeoutMs) {
  signal.throwIfAborted();
  const controller=new AbortController();let timer,onAbort;
  try {
    return await Promise.race([
      Promise.resolve().then(()=>{controller.signal.throwIfAborted();return operation(controller.signal);}),
      new Promise((_,reject)=>{
        onAbort=()=>{controller.abort();reject(new LoopError('LOOP_CANCELLED'));};
        signal.addEventListener('abort',onAbort,{once:true});
        timer=setTimeout(()=>{controller.abort();reject(new LoopError('LOOP_STAGE_TIMEOUT'));},timeoutMs);
        if(signal.aborted)onAbort();
      }),
    ]);
  } finally {clearTimeout(timer);signal.removeEventListener('abort',onAbort);controller.abort();}
}
async function runLoop(options) {
  const {signal,observe,decide,execute}=options;
  const maxCycles=options.maxCycles??100,stageTimeoutMs=options.stageTimeoutMs??60000;
  if(!Number.isInteger(maxCycles)||maxCycles<1||maxCycles>10000||!Number.isInteger(stageTimeoutMs)||stageTimeoutMs<1||stageTimeoutMs>2147483647)throw new LoopError('LOOP_INVALID_BUDGET');
  const thinkingTimeoutMs=options.thinkingTimeoutMs??15000,maxThinkingCalls=options.maxThinkingCalls??60;
  if(!Number.isInteger(thinkingTimeoutMs)||thinkingTimeoutMs<1||thinkingTimeoutMs>2147483647||!Number.isInteger(maxThinkingCalls)||maxThinkingCalls<0||maxThinkingCalls>10000)throw new LoopError('LOOP_INVALID_BUDGET');
  let thinkingCalls=0;
  for(let cycle=0;cycle<maxCycles;cycle++) {
    signal.throwIfAborted();
    const invoke=(fn)=>bounded(async local=>{const think=async request=>{
      local.throwIfAborted();
      if(typeof options.thinking!=='function')throw new LoopError('LOOP_THINKING_UNAVAILABLE');
      if(thinkingCalls>=maxThinkingCalls)throw new LoopError('LOOP_THINKING_BUDGET');
      thinkingCalls++;
      const output=await bounded(child=>options.thinking(request,child),local,thinkingTimeoutMs);
      local.throwIfAborted();return output;
    };const result=await fn({cycle,signal:local,think});local.throwIfAborted();return result;},signal,stageTimeoutMs);
    const state=await invoke(observe);
    const decision=await invoke(ctx=>decide(state,ctx));
    if(!decision||typeof decision!=='object'||('result' in decision)===('action' in decision))throw new LoopError('LOOP_INVALID_DECISION');
    if('result' in decision)return decision.result;
    const result=await invoke(ctx=>execute(decision.action,ctx));
    if(result!==undefined)return result;
  }
  throw new LoopError('LOOP_CYCLE_BUDGET');
}
/** Domain-neutral tools remain host-defined. The chooser cannot supply executable code. */
function toolRegistry(tools) {
  const map=new Map();
  for(const tool of tools){if(!tool.id||map.has(tool.id))throw new LoopError('LOOP_INVALID_TOOLS');map.set(tool.id,tool);}
  return {
    async call(id,input,context){
      context.signal.throwIfAborted();const tool=map.get(id);if(!tool)throw new LoopError('LOOP_UNKNOWN_TOOL');
      const parsed=tool.parse(input);if(!await tool.authorize(parsed,context))throw new LoopError('LOOP_ACCESS_DENIED');
      context.signal.throwIfAborted();
      // Host must durably record intent before dispatch; never retry a mutation here.
      if(tool.mutating){if(!context.beforeMutation)throw new LoopError('LOOP_CHECKPOINT_REQUIRED');await context.beforeMutation(id,parsed);context.signal.throwIfAborted();if(!await tool.authorize(parsed,context))throw new LoopError('LOOP_ACCESS_DENIED');context.signal.throwIfAborted();}
      return tool.execute(parsed,context);
    },
    ids:()=>[...map.keys()],
  };
}
exports.runLoop=runLoop;exports.toolRegistry=toolRegistry;exports.LoopError=LoopError;
