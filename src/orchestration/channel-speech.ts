import { resolveVoiceId } from '../voice/providers/voice-catalog';
import { convertLineAudio } from '../voice/line-audio';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AgentConfig } from '../types';
import type { Row } from './store';
import type { DeliveryOutcome } from './delivery';
import { sendTelegramSpeech, SpeechDelivery, speechSynthesisFailure } from './telegram-speech';
import { ttsProvider } from '../voice/providers/registry';
import { mp3DurationMs } from '../voice/mp3';
import { ingestOrchestrationMedia } from './media';
import { sendChannelFile } from './file-delivery';

export async function sendChannelSpeech(agent:AgentConfig,binding:Row,speech:SpeechDelivery,id:string,request:typeof fetch=fetch,provider:typeof ttsProvider=ttsProvider,enabled:()=>boolean=()=>true):Promise<DeliveryOutcome>{
  if(binding.channel==='telegram')return sendTelegramSpeech(agent,binding,speech,request,provider,enabled);
  if(!enabled())return {state:'failed',code:'VOICE_REPLY_DISABLED'};
  if(!['discord','line','slack'].includes(String(binding.channel)))return {state:'failed',code:'VOICE_DELIVERY_NOT_CONFIGURED'};
  if(!speech.text?.trim()||speech.text.length>600||speech.text.includes('```'))return {state:'failed',code:'INVALID_SPEECH_SUMMARY'};
  let audio,duration:number;
  try{
    const tts=provider(speech);if(!tts.synthesizeFile)return {state:'failed',code:'TTS_FILE_UNSUPPORTED',speechSynthesisFailed:true};
    audio=await tts.synthesizeFile({text:speech.text,voiceId:await resolveVoiceId(speech),signal:AbortSignal.timeout(60000)});
    if(!audio.bytes.length||audio.bytes.length>5*1024*1024)throw Error('INVALID_AUDIO');
    duration=mp3DurationMs(audio.bytes);
  }catch(error){return enabled()?speechSynthesisFailure(error):{state:'failed',code:'VOICE_REPLY_DISABLED'};}
  if(!enabled())return {state:'failed',code:'VOICE_REPLY_DISABLED'};
  const temporary=mkdtempSync(join(tmpdir(),'gateway-speech-'));
  try{
    let file=join(temporary,'reply.mp3'),name='reply.mp3';writeFileSync(file,audio.bytes,{mode:0o600});
    if(binding.channel==='line'){
      const converted=join(temporary,'reply.m4a');
      try{duration=await convertLineAudio(file,converted);}catch{return {state:'failed',code:'LINE_AUDIO_CONVERSION_FAILED'};}
      file=converted;name='reply.m4a';
    }
    if(!enabled())return {state:'failed',code:'VOICE_REPLY_DISABLED'};
    const path=ingestOrchestrationMedia(join(agent.workspace,'../..'),agent.id,`speech-${binding.channel}`,file);
    return await sendChannelFile(agent,binding,{path,name,kind:'audio',caption:'',durationMs:duration},id,request,enabled);
  }catch{return {state:'failed',code:'VOICE_MEDIA_UNAVAILABLE'};}
  finally{rmSync(temporary,{recursive:true,force:true});}
}
