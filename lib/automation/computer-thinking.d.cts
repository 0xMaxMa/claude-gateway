import type {ThinkingConfig} from './thinking.cjs';
export function thinkComputerField(config:ThinkingConfig,input:Record<string,unknown>,signal:AbortSignal,requestFetch?:typeof fetch):Promise<{text:string|null}>;
