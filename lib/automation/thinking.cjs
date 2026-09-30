'use strict';
/** Tool-free JSON inference shared by text, planning and verification tools. */
async function thinkJson(config, request, signal, requestFetch=fetch) {
  const input=JSON.stringify(request.input);
  if(!input||Buffer.byteLength(input)>65536||typeof request.instruction!=='string'||request.instruction.length>16000)throw Error('THINKING_INVALID_INPUT');
  const images=request.images??[];
  if(!Array.isArray(images)||images.length>1||images.some(i=>!i||!['image/png','image/jpeg'].includes(i.mimeType)||typeof i.data!=='string'||i.data.length>8*1024*1024||!/^[A-Za-z0-9+/]+={0,2}$/.test(i.data)))throw Error('THINKING_INVALID_INPUT');
  const url=new URL(config.baseUrl);
  if(url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw Error('THINKING_INVALID_CONFIG');
  if(!['openai-chat','anthropic-messages'].includes(config.api??'openai-chat')||!config.model||!config.apiKey||/[\r\n]/.test(config.apiKey))throw Error('THINKING_INVALID_CONFIG');
  signal.throwIfAborted();const anthropic=config.api==='anthropic-messages';
  const response=await requestFetch(config.baseUrl.replace(/\/$/,'')+(anthropic?'/messages':'/chat/completions'),{
    method:'POST',redirect:'error',signal,
    headers:{Authorization:`Bearer ${config.apiKey}`,'Content-Type':'application/json',...(anthropic?{'anthropic-version':'2023-06-01'}:{})},
    body:JSON.stringify({model:config.model,max_tokens:512,stream:false,...(anthropic?{system:request.instruction,messages:[{role:'user',content:images.length?[{type:'text',text:input},...images.map(i=>({type:'image',source:{type:'base64',media_type:i.mimeType,data:i.data}}))]:input}]}:{response_format:{type:'json_object'},messages:[{role:'system',content:request.instruction},{role:'user',content:images.length?[{type:'text',text:input},...images.map(i=>({type:'image_url',image_url:{url:'data:'+i.mimeType+';base64,'+i.data}}))]:input}]})}),
  });
  if(!response.ok){await response.body?.cancel();throw Error('THINKING_HTTP_'+response.status);}
  const reader=response.body?.getReader();if(!reader)throw Error('THINKING_INVALID_RESPONSE');
  let body='',size=0;const decoder=new TextDecoder();
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>65536)throw Error('THINKING_INVALID_RESPONSE');body+=decoder.decode(value,{stream:true});}body+=decoder.decode();}finally{await reader.cancel().catch(()=>{});}
  signal.throwIfAborted();
  try{
    const envelope=JSON.parse(body);
    if(anthropic?envelope.stop_reason!=='end_turn':envelope.choices?.[0]?.finish_reason!=='stop')throw Error();
    const content=anthropic?envelope.content?.filter(b=>b.type==='text').map(b=>b.text).join(''):envelope.choices[0].message.content;
    const output=JSON.parse(content);
    if(!output||Array.isArray(output)||typeof output!=='object')throw Error();
    const usage={};for(const name of ['input_tokens','output_tokens','prompt_tokens','completion_tokens','cache_read_input_tokens']){const n=envelope.usage?.[name];if(Number.isSafeInteger(n)&&n>=0)usage[name]=n;}
    return {output,model:config.model,usage};
  }catch{throw Error('THINKING_INVALID_RESPONSE');}
}
exports.thinkJson=thinkJson;
