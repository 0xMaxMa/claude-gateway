export interface LoopContext { cycle:number; signal:AbortSignal; think(request:unknown):Promise<unknown> }
export class LoopError extends Error { code:string; constructor(code:string) }
export function runLoop<S,D,R>(options:{signal:AbortSignal;maxCycles?:number;stageTimeoutMs?:number;thinking?:(request:unknown,signal:AbortSignal)=>Promise<unknown>;thinkingTimeoutMs?:number;maxThinkingCalls?:number;observe(context:LoopContext):Promise<S>;decide(state:S,context:LoopContext):Promise<{action:D}|{result:R}>;execute(action:D,context:LoopContext):Promise<R|undefined>}):Promise<R>;
