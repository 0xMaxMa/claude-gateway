import type { AgentConfig } from '../types';
import { ingestOrchestrationMedia } from './media';
import { receiveChannelMedia } from './channel-media';
import { OrchestrationError } from './types';
export async function channelInputMedia(agent: AgentConfig, root: string, source: string, chatId: string, meta: Record<string,string>, discard: (path:string)=>void) {
  type Attachment = {path?:string;ref?:string;name?:string;kind?:string;quoted?:boolean};
  const items: Attachment[] = [];
  if(meta.attachments_json){
    const parsed=JSON.parse(meta.attachments_json);
    if(!Array.isArray(parsed)||parsed.length>20||parsed.some(a=>!a||typeof a!=='object'||(a.path!==undefined&&typeof a.path!=='string')||(a.ref!==undefined&&typeof a.ref!=='string')||(a.name!==undefined&&typeof a.name!=='string')||(a.kind!==undefined&&typeof a.kind!=='string')||(a.quoted!==undefined&&typeof a.quoted!=='boolean')||(!a.path&&!a.ref)))throw new OrchestrationError('INVALID_ATTACHMENT');
    items.push(...parsed);
  } else {
    if(meta.image_path||meta.document_path||meta.sticker_path)items.push({path:meta.image_path||meta.document_path||meta.sticker_path,name:meta.attachment_name});
    else if(meta.attachment_file_id)items.push({ref:meta.attachment_file_id,name:meta.attachment_name});
  }
  if(meta.replied_image_path)items.push({path:meta.replied_image_path,quoted:true});
  else if(meta.replied_attachment_file_id)items.push({ref:meta.replied_attachment_file_id,name:meta.replied_attachment_name,quoted:true});
  const media: string[]=[],quoted: string[]=[],details: Array<{ref:string;name?:string;quoted:boolean}>=[];
  const seen=new Map<string,string>();
  for(const item of items){
    const key=item.path??item.ref;if(!key)continue;
    let ref=seen.get(key);
    if(!ref){
      try {
        ref=item.path?ingestOrchestrationMedia(root,agent.id,`${source}-${chatId}`,item.path):await receiveChannelMedia(agent,root,source,chatId,item.ref!);
      } catch (error) {
        // An expired quote must not discard the user's new message or its own files.
        if(!item.quoted)throw error;
        meta.attachment_error=[meta.attachment_error,'A quoted attachment is unavailable. Do not claim to have read it.'].filter(Boolean).join(' ');
        continue;
      }
      seen.set(key,ref); media.push(ref);
      if(item.path&&meta.media_ephemeral==='1')discard(item.path);
    }
    if(item.quoted)quoted.push(ref);
    details.push({ref,name:item.name,quoted:Boolean(item.quoted)});
  }
  return {media,quoted:[...new Set(quoted)],details};
}
