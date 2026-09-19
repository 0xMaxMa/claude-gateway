import { promises as fs } from 'fs';

export interface CompactMeasurements { beforeTokens:number|null; afterTokens:number|null; }
export function compactMeasurements(event:any):CompactMeasurements|null {
  if(event?.type!=='system'||event?.subtype!=='compact_boundary')return null;
  const metadata=event.compactMetadata??event.compact_metadata;
  const token=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
  const beforeTokens=token(metadata?.preTokens??metadata?.pre_tokens),afterTokens=token(metadata?.postTokens??metadata?.post_tokens);
  return beforeTokens===null&&afterTokens===null?null:{beforeTokens,afterTokens};
}
/** Passive, bounded read of already-written CLI metadata. Never invokes the CLI/model. */
export async function readCompactMeasurements(filename:string,startedAt:number,endedAt:number):Promise<CompactMeasurements|null> {
  let handle;
  try {
    handle=await fs.open(filename,'r');const stat=await handle.stat();if(!stat.isFile())return null;
    const length=Math.min(stat.size,1024*1024),start=stat.size-length,buffer=Buffer.alloc(length);
    const {bytesRead}=await handle.read(buffer,0,length,start);
    const lines=buffer.subarray(0,bytesRead).toString('utf8').split('\n');if(start>0)lines.shift();
    let found:CompactMeasurements|null=null;
    for(const line of lines){try{const event=JSON.parse(line),at=Date.parse(event.timestamp);if(at>=startedAt&&at<=endedAt){const measured=compactMeasurements(event);if(measured)found=measured;}}catch{/* incomplete/non-protocol line */}}
    return found;
  }catch{return null;}finally{await handle?.close().catch(()=>{});}
}

/** Reduction is reported only for complete before/after pairs. */
export function compactionTotals(items: Array<{status:string;beforeTokens:number|null;afterTokens:number|null;contextWindow?:number|null}>) {
  const done=items.filter(i=>i.status==='completed');
  const valid=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
  const paired=done.filter(i=>valid(i.beforeTokens)&&valid(i.afterTokens));
  return {
    beforeTokens:done.length&&done.every(i=>valid(i.beforeTokens))?done.reduce((n,i)=>n+i.beforeTokens!,0):null,
    afterTokens:done.length&&done.every(i=>valid(i.afterTokens))?done.reduce((n,i)=>n+i.afterTokens!,0):null,
    contextWindow:done.length&&done.every(i=>valid(i.contextWindow)&&i.contextWindow!>0)?done.reduce((n,i)=>n+i.contextWindow!,0):null,
    measuredSessions:paired.length,
    measuredReduction:paired.reduce((n,i)=>n+i.beforeTokens!-i.afterTokens!,0),
  };
}
