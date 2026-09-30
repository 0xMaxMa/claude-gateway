import {readFile,stat} from 'node:fs/promises';
import type {ThinkingConfig} from '../../lib/automation/thinking.cjs';
import type {BrowserTextHelperConfig} from './browser-contract';
/** Credentials stay in the host; reasoning instructions belong to the built-in controller. */
export async function thinkingProvider(config:BrowserTextHelperConfig):Promise<ThinkingConfig>{
 let apiKey:string;
 if(config.apiKeyFile){if((await stat(config.apiKeyFile)).size>16384)throw Error('THINKING_CREDENTIAL_INVALID');apiKey=(await readFile(config.apiKeyFile,'utf8')).trim();}
 else apiKey=process.env[config.apiKeyEnv??'']??'';
 if(!apiKey||apiKey.length>16384||/[\x00-\x20\x7f]/.test(apiKey))throw Error('THINKING_CREDENTIAL_UNAVAILABLE');
 return {api:config.api,baseUrl:config.baseUrl,model:config.model,apiKey};
}

/** Provider transport/config errors are blockers, never a request for missing user facts. */
export function thinkingFailure(error:unknown):Error {
 const code=error instanceof Error?error.message:'';
 return Error(/^THINKING_(?:HTTP_[0-9]{3}|[A-Z_]{1,64})$/.test(code)?code:'THINKING_PROVIDER_FAILED');
}
