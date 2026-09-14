import { createHash } from 'node:crypto';
export type ChannelInput = {content:string;meta:Record<string,string>};
export function mediaGroupKey(input: ChannelInput): string | undefined {
 const m=input?.meta;
 return m?.media_group_id ? createHash('sha256').update(JSON.stringify([m.chat_id,m.user_id,m.message_thread_id??'',m.media_group_id])).digest('hex') : undefined;
}
/** Telegram albums arrive as separate updates. Keep the native group intact. */
export function mergeMediaGroup(prior:ChannelInput|undefined,input:ChannelInput):ChannelInput {
 const ids:string[]=prior?JSON.parse(prior.meta.message_ids_json):[];
 if(ids.includes(input.meta.message_id))return prior!;
 if(ids.length>=10)throw Error('Telegram media group exceeds 10 items');
 const parts:Array<{id:string;caption:string;ref?:string;path?:string;name?:string}> = prior?JSON.parse(prior.meta.media_group_parts_json):[];
 parts.push({id:input.meta.message_id,caption:input.meta.media_caption??'',ref:input.meta.attachment_file_id,path:input.meta.image_path,name:input.meta.attachment_name});
 parts.sort((a,b)=>Number(a.id)-Number(b.id));
 const meta:Record<string,string>={...(prior?.meta??input.meta),media_group_id:input.meta.media_group_id,message_id:parts[0]!.id,
  message_ids_json:JSON.stringify(parts.map(p=>p.id)),media_group_parts_json:JSON.stringify(parts),
  attachments_json:JSON.stringify(parts.map(({ref,path,name})=>({ref,path,name})))};
 // Album files must not turn a mixed album into a single-file voice-note turn.
 delete meta.attachment_file_id;delete meta.image_path;delete meta.attachment_kind;
 return {content:parts.map(p=>p.caption).filter(Boolean).join('\n\n')||'[Media album attached]',meta};
}
