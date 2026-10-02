import type {ThinkingConfig} from './thinking.cjs';
export function thinkBrowserField(config:ThinkingConfig,input:unknown,signal:AbortSignal,requestFetch?:typeof fetch):Promise<{text:string|null}>;
