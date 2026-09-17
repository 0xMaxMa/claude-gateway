import type { AgentConfig } from '../types';
import { ingestOrchestrationMedia } from './media';
import { receiveChannelMedia } from './channel-media';
import { OrchestrationError } from './types';
import { classifyChannelMediaError } from './channel-media-error';
export async function channelInputMedia(agent: AgentConfig, root: string, source: string, chatId: string, meta: Record<string,string>, discard: (path:string)=>void) {
  type Attachment = {path?:string;ref?:string;name?:string;kind?:string;quoted?:boolean;size?:number};
  const items: Attachment[] = [];
  if(meta.attachments_json){
    let parsed: unknown;
    try { parsed=JSON.parse(meta.attachments_json); } catch { throw new OrchestrationError('INVALID_ATTACHMENT'); }
    if(!Array.isArray(parsed)||parsed.length>20||parsed.some(a=>!a||typeof a!=='object'||(a.path!==undefined&&typeof a.path!=='string')||(a.ref!==undefined&&typeof a.ref!=='string')||(a.name!==undefined&&typeof a.name!=='string')||(a.kind!==undefined&&typeof a.kind!=='string')||(a.quoted!==undefined&&typeof a.quoted!=='boolean')||(!a.path&&!a.ref)))throw new OrchestrationError('INVALID_ATTACHMENT');
    items.push(...parsed);
  } else {
    if(meta.image_path||meta.document_path||meta.sticker_path)items.push({path:meta.image_path||meta.document_path||meta.sticker_path,name:meta.attachment_name,size:meta.attachment_size===undefined?undefined:Number(meta.attachment_size)});
    else if(meta.attachment_file_id)items.push({ref:meta.attachment_file_id,name:meta.attachment_name,size:meta.attachment_size===undefined?undefined:Number(meta.attachment_size)});
  }
  if(meta.replied_image_path)items.push({path:meta.replied_image_path,quoted:true});
  else if(meta.replied_attachment_file_id)items.push({ref:meta.replied_attachment_file_id,name:meta.replied_attachment_name,size:meta.replied_attachment_size===undefined?undefined:Number(meta.replied_attachment_size),quoted:true});
  const primaryDirect = items.find(item=>!item.quoted);
  let primaryDirectMedia: string | undefined;
  const media: string[]=[],quoted: string[]=[],details: Array<{ref:string;name?:string;quoted:boolean}>=[];
  const unavailable: Array<{code:string;name?:string;quoted:boolean}>=[];
  const discardPaths=new Set<string>();
  const seen=new Map<string,string>();
  for(const item of items){
    const key=item.path??item.ref;if(!key)continue;
    let ref=seen.get(key);
    if(!ref){
      try {
        if(item.size!==undefined&&(!Number.isSafeInteger(item.size)||item.size<0))throw new OrchestrationError('INVALID_ATTACHMENT');
        if(item.size!==undefined&&item.size>(source==='telegram'?20:50)*1024*1024)throw new OrchestrationError('ATTACHMENT_TOO_LARGE');
        ref=item.path?ingestOrchestrationMedia(root,agent.id,`${source}-${chatId}`,item.path):await receiveChannelMedia(agent,root,source,chatId,item.ref!,fetch,item.size);
      } catch (error) {
        const failure=classifyChannelMediaError(error);
        if(failure.retryable)throw failure;
        const name=item.name?.replace(/[\x00-\x1f\x7f]/g,'').slice(0,200);
        unavailable.push({code:failure.code,...(name?{name}:{}),quoted:Boolean(item.quoted)});
        continue;
      }
      seen.set(key,ref); media.push(ref);
      if(item.path&&meta.media_ephemeral==='1')discardPaths.add(item.path);
    }
    if(item===primaryDirect)primaryDirectMedia=ref;
    if(item.quoted)quoted.push(ref);
    details.push({ref,name:item.name,quoted:Boolean(item.quoted)});
  }
  if(unavailable.length) {
    const diagnostic=unavailable.some(item=>item.quoted)?'A quoted attachment is unavailable. Do not claim to have read it.':'An attachment is unavailable. Do not claim to have read it.';
    meta.attachment_error=[meta.attachment_error,diagnostic].filter(Boolean).join(' ');
  }
  for(const path of discardPaths)discard(path);
  return {media,quoted:[...new Set(quoted)],details,unavailable,primaryDirectMedia};
}
