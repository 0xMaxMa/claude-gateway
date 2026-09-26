import {readFile,stat} from 'node:fs/promises';
import type {ThinkingConfig} from '@0xmaxma/jev-loop/thinking';
import type {BrowserTextHelperConfig} from './browser-contract';
/** Credentials stay in the host; all reasoning instructions belong to Jev Loop. */
export async function thinkingProvider(config:BrowserTextHelperConfig):Promise<ThinkingConfig>{
 let apiKey:string;
 if(config.apiKeyFile){if((await stat(config.apiKeyFile)).size>16384)throw Error('THINKING_CREDENTIAL_INVALID');apiKey=(await readFile(config.apiKeyFile,'utf8')).trim();}
 else apiKey=process.env[config.apiKeyEnv??'']??'';
 if(!apiKey||apiKey.length>16384||/[\x00-\x20\x7f]/.test(apiKey))throw Error('THINKING_CREDENTIAL_UNAVAILABLE');
 return {api:config.api,baseUrl:config.baseUrl,model:config.model,apiKey};
}
