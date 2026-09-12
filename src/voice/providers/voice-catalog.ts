import { providerHttpError } from '../errors';
import { geminiConnection, GEMINI_VOICES } from './gemini';
import { paxaConnection } from './paxalabs-tts';
import { upstreamVoiceConnection } from './upstream';
import { createHash } from 'crypto';
export interface VoiceChoice { id: string; name: string; gender?: string }
type Catalog = { key: () => string; list: (key: string) => Promise<VoiceChoice[]> };
const gender = (input: unknown): string | undefined => {
  const value = typeof input === 'string' ? input.trim().toLowerCase() : undefined;
  return value==='m'||value==='male'||value==='masculine' ? 'male' : value==='f'||value==='female'||value==='feminine' ? 'female' : value==='neutral'||value==='gender_neutral' ? 'neutral' : undefined;
};
/** New TTS adapters register their catalog here; consumers share this provider-neutral interface. */
const catalogs: Record<string, Catalog> = {
  upstream: {
    key: () => { const { base, key } = upstreamVoiceConnection(); return base.toString() + '\0' + key; },
    list: async () => {
      const { base, key } = upstreamVoiceConnection();
      const response = await fetch(new URL('voices', base), { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000), redirect: 'error' });
      if (!response.ok) throw await providerHttpError('VOICE', response);
      const body = await response.json() as {voices?:Array<{voice_id:string;name:string;labels?:{gender?:string}}>};
      if (!Array.isArray(body.voices)) throw Error('VOICE_CATALOG_UNAVAILABLE');
      return body.voices.filter(v=>typeof v.voice_id==='string'&&typeof v.name==='string').map(v=>({id:v.voice_id,name:v.name,gender:gender(v.labels?.gender)}));
    },
  },
  elevenlabs: {
    key: () => process.env.ELEVENLABS_API_KEY ?? '',
    list: async key => {
      const response=await fetch('https://api.elevenlabs.io/v1/voices',{headers:{'xi-api-key':key},signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw await providerHttpError('VOICE', response);
      const body=await response.json() as {voices?:Array<{voice_id:string;name:string;labels?:{gender?:string}}>};
      if(!Array.isArray(body.voices))throw Error('VOICE_CATALOG_UNAVAILABLE');
      return body.voices.filter(v=>typeof v.voice_id==='string'&&typeof v.name==='string').map(v=>({id:v.voice_id,name:v.name,...(gender(v.labels?.gender)?{gender:gender(v.labels?.gender)}:{})}));
    },
  },
  cartesia: {
    key: () => process.env.CARTESIA_API_KEY ?? '',
    list: async key => {
      const voices:VoiceChoice[]=[];let cursor='';const signal=AbortSignal.timeout(15000);
      for(let page=0;page<20;page++) {
        const url=new URL('https://api.cartesia.ai/voices');url.searchParams.set('limit','100');if(cursor)url.searchParams.set('starting_after',cursor);
        const response=await fetch(url,{headers:{Authorization:`Bearer ${key}`,'Cartesia-Version':'2026-08-14'},signal});
        if(!response.ok)throw await providerHttpError('VOICE', response);
        const body=await response.json() as {data?:Array<{id:string;name:string;gender?:string}>;has_more?:boolean;next_page?:string};
        if(!Array.isArray(body.data))throw Error('VOICE_CATALOG_UNAVAILABLE');
        voices.push(...body.data.filter(v=>typeof v.id==='string'&&typeof v.name==='string').map(v=>({id:v.id,name:v.name,...(gender(v.gender)?{gender:gender(v.gender)}:{})})));
        if(!body.has_more)return voices;
        if(!body.next_page||body.next_page===cursor)throw Error('VOICE_CATALOG_UNAVAILABLE');
        cursor=body.next_page;
      }
      throw Error('VOICE_CATALOG_TOO_LARGE');
    },
  },
};
for (const provider of ['paxalabs', 'upstream:paxalabs']) catalogs[provider] = {
  key: () => { const { base, key } = paxaConnection(provider); return key ? base.toString() + '\0' + key : ''; },
  list: async () => {
    const { base, key } = paxaConnection(provider);
    const response = await fetch(new URL('voices', base), { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000), redirect: 'error' });
    if (!response.ok) throw await providerHttpError('VOICE', response);
    const body = await response.json() as { voices?: Array<{ id: string; name: string; gender?: string }> };
    if (!Array.isArray(body.voices)) throw Error('VOICE_CATALOG_UNAVAILABLE');
    return body.voices.filter(v => typeof v.id === 'string' && typeof v.name === 'string').map(v => ({ id: v.id, name: v.name, gender: gender(v.gender) }));
  },
};
for (const provider of ['gemini', 'upstream:gemini']) catalogs[provider] = {
  key: () => { const { base, key } = geminiConnection(provider); return key ? base.toString() + '\0' + key : ''; },
  list: async () => GEMINI_VOICES,
};
const cache=new Map<string,{until:number;voices:VoiceChoice[]}>();
export async function voiceChoices(config:{provider:string;voiceId:string}):Promise<VoiceChoice[]> {
  const catalog=catalogs[config.provider];if(!catalog)throw Error('VOICE_CATALOG_UNSUPPORTED');
  const credential=catalog.key();if(!credential)throw Error('VOICE_CATALOG_UNAVAILABLE');
  const key=createHash('sha256').update(config.provider+'\0'+credential).digest('hex');
  const cached=cache.get(key);if(cached&&cached.until>Date.now())return cached.voices;
  const voices=await catalog.list(credential);
  if(cache.size>=20)cache.delete(cache.keys().next().value!);
  cache.set(key,{until:Date.now()+300000,voices});return voices;
}

// Keep Auto stable for this gateway process, separately for each provider/account.
const automatic = new Map<string, VoiceChoice>();
export async function resolveVoiceId(config: {provider: string; voiceId: string}): Promise<string> {
  if (config.voiceId.trim()) return config.voiceId.trim();
  const catalog = catalogs[config.provider];
  if (!catalog) throw Error('VOICE_CATALOG_UNSUPPORTED');
  const credential = catalog.key();
  if (!credential) throw Error('VOICE_CATALOG_UNAVAILABLE');
  const key = createHash('sha256').update(config.provider + '\0' + credential).digest('hex');
  const selected = automatic.get(key);
  if (selected) return selected.id;
  const voices = await voiceChoices(config);
  // Catalog ordering can change between requests. Sort IDs instead of picking
  // whichever voice the provider happens to return first.
  const choice = voices.filter(v => v.id.trim()).slice().sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)[0];
  if (!choice) throw Error('VOICE_CATALOG_UNAVAILABLE');
  if (automatic.size >= 100) automatic.delete(automatic.keys().next().value!);
  automatic.set(key, choice);
  return choice.id;
}
