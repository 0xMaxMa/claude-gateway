import {EventEmitter} from 'events';
import {startNativeCompact} from '../../../src/orchestration/native-compact';
import type {SessionProcess} from '../../../src/session/process';

function fixture(events: unknown[]) {
  const p = new EventEmitter() as SessionProcess;
  Object.assign(p,{start:async()=>{},stop:async()=>{},sendMessage:jest.fn(()=>{for(const e of events)p.emit('output',JSON.stringify(e));})});
  return p;
}
test('native compact sends only the slash command and requires the CLI boundary',async()=>{
 const p=fixture([{type:'system',subtype:'compact_boundary',compact_metadata:{trigger:'manual',pre_tokens:20000}},{type:'result',result:'Compacted'}]);
 await expect(startNativeCompact(p).result).resolves.toMatchObject({interrupted:false});
 expect(p.sendMessage).toHaveBeenCalledWith('/compact',[]);
 expect(p.listenerCount('output')).toBe(0);
});
test('prose claiming success cannot masquerade as native compaction',async()=>{
 const p=fixture([{type:'result',result:'I summarized your conversation.'}]);
 await expect(startNativeCompact(p).result).rejects.toMatchObject({code:'COMPACT_NOT_CONFIRMED'});
 expect(p.listenerCount('output')).toBe(0);
});
test('provider failure stays a failure, even after a boundary',async()=>{
 const p=fixture([{type:'system',subtype:'compact_boundary'},{type:'result',is_error:true,result:'API Error: 503 unavailable'}]);
 await expect(startNativeCompact(p).result).rejects.toMatchObject({code:'PROVIDER_UNAVAILABLE'});
});
