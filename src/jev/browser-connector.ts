import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { BrowserConnectorConfig, BrowserExecutionContext, BrowserExecutionResult, BrowserIntegrationConfig, BrowserRunnerModule } from './browser-contract';
import type { BrowserTaskBinding } from '../orchestration/gateway-tasks/browser';
import { JevError } from './types';
import { isReservedJevCredentialEnv } from './child-env';

const invalid = (): never => { throw new JevError('INVALID_CONFIG', 'Invalid browser integration configuration.'); };
const object = (v: unknown): v is Record<string, any> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const string = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
export function validateBrowserIntegration(value: BrowserIntegrationConfig | undefined): void {
  if (value === undefined) return;
  if (!object(value) || Object.keys(value).some(k => !['runnerModule','bindings'].includes(k)) || !string(value.runnerModule,4096) || !(isAbsolute(value.runnerModule) || /^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(value.runnerModule)) || !Array.isArray(value.bindings) || value.bindings.length > 100) invalid();
  const ids = new Set<string>();
  for (const b of value.bindings) {
    if (!object(b) || Object.keys(b).some(k => !['id','name','agentId','principalId','conversationId','endpoint','apiKeyEnv','apiKeyFile','scope','fields','budget'].includes(k)) || ![b.id,b.name,b.agentId,b.principalId,b.conversationId].every(v => string(v)) || ids.has(b.id)) invalid();
    ids.add(b.id);
    let url: URL; try { url = new URL(b.endpoint); } catch { invalid(); }
    if (url!.username || url!.password || url!.hash || url!.search || (url!.protocol !== 'https:' && !(url!.protocol === 'http:' && ['127.0.0.1','[::1]','localhost'].includes(url!.hostname)))) invalid();
    if (Boolean(b.apiKeyEnv) === Boolean(b.apiKeyFile)) invalid();
    if (b.apiKeyEnv !== undefined && (!string(b.apiKeyEnv) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(b.apiKeyEnv) || isReservedJevCredentialEnv(b.apiKeyEnv))) invalid();
    if (b.apiKeyFile !== undefined && (!string(b.apiKeyFile,4096) || !isAbsolute(b.apiKeyFile))) invalid();
    if (!object(b.scope) || Object.keys(b.scope).length !== 3 || !['device_id','grant_id','tab_id'].every(k => string((b.scope as any)[k],120))) invalid();
    if (b.fields !== undefined && (!Array.isArray(b.fields) || b.fields.length > 60 || b.fields.some(f => !object(f) || Object.keys(f).some(k => !['label','text'].includes(k)) || !string(f.label,250) || typeof f.text !== 'string' || f.text.length > 2000))) invalid();
    if (b.budget !== undefined) {
      const ranges: Record<string,[number,number]> = {maxSteps:[1,100],maxEvaluations:[1,150],timeoutMs:[1000,600000],maxTextCalls:[0,60],maxStaleRetries:[0,10],operationConfidence:[0,1],targetConfidence:[0,1]};
      if (!object(b.budget)) invalid();
      for (const [k,v] of Object.entries(b.budget)) if (!ranges[k] || typeof v !== 'number' || !Number.isFinite(v) || v < ranges[k][0] || v > ranges[k][1] || (!k.endsWith('Confidence') && !Number.isInteger(v))) invalid();
    }
  }
}

// Preserve native import for optional ESM packages when gateway is compiled as CJS.
const importModule = new Function('url', 'return import(url)') as (url: string) => Promise<BrowserRunnerModule>;
const tools = new Set(['browser_task_acquire','browser_task_renew','browser_task_release','page_observe','page_click','page_type','page_select','page_scroll']);
async function credential(binding: BrowserConnectorConfig): Promise<string> {
  let key: string;
  if (binding.apiKeyFile) {
    if ((await stat(binding.apiKeyFile)).size > 16384) throw Error('BROWSER_CREDENTIAL_INVALID');
    key = (await readFile(binding.apiKeyFile, 'utf8')).trim();
  } else key = process.env[binding.apiKeyEnv!] ?? '';
  if (!key || key.length > 16384 || /[\x00-\x20\x7f]/.test(key)) throw Error('BROWSER_CREDENTIAL_UNAVAILABLE');
  return key;
}
export async function executeBrowserModule(modulePath: string, binding: BrowserConnectorConfig, context: BrowserExecutionContext): Promise<BrowserExecutionResult> {
  const assertAccess = () => { if (!context.authorized()) throw Error('ACCESS_DENIED'); };
  assertAccess(); context.signal.throwIfAborted();
  const resolved = isAbsolute(modulePath) ? modulePath : createRequire(__filename).resolve(modulePath);
  const module = await importModule(pathToFileURL(resolved).href);
  if (module.BROWSER_RUNNER_CONTRACT_VERSION !== 1 || typeof module.runBrowserTask !== 'function' || typeof module.mcpBrowserTransport !== 'function') throw Error('BROWSER_RUNNER_INCOMPATIBLE');
  const key = await credential(binding);
  assertAccess(); context.signal.throwIfAborted();
  const client = new Client({name:'gateway-browser-task',version:'1.0.0'});
  // Fetch is pinned to the configured endpoint. Redirects must never forward the credential.
  const endpoint = new URL(binding.endpoint);
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: {Authorization:`Bearer ${key}`}, redirect:'error' },
    fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (target.origin !== endpoint.origin || target.pathname !== endpoint.pathname) throw Error('BROWSER_ENDPOINT_CHANGED');
      return fetch(input, {...init, redirect:'error'});
    }) as typeof fetch,
  });
  try {
    await client.connect(transport, {signal: context.signal, timeout:10000});
    const call = module.mcpBrowserTransport(async (name,args,signal) => {
      // Release only the already-held lease even after config revocation; no other late call is allowed.
      if (name !== 'browser_task_release') assertAccess();
      if (!tools.has(name) || ['device_id','grant_id','tab_id'].some(k => args[k] !== binding.scope[k as keyof typeof binding.scope])) throw Error('BROWSER_SCOPE_DENIED');
      const result = await client.callTool({name,arguments:args}, undefined, {signal,timeout:35000});
      return {content:result.content as unknown[],isError:result.isError as boolean | undefined};
    });
    let independentlyVerified = false;
    const result = await module.runBrowserTask({contractVersion:1,goal:context.goal,scope:binding.scope,fields:[...(binding.fields??[]),...(context.fields??[]).filter(f=>!(binding.fields??[]).some(b=>b.label===f.label))],...binding.budget}, {
      call,
      evaluate: async(request,signal) => { assertAccess(); const response = await context.evaluate(request,signal); assertAccess(); return {model:response.model,answers:response.answers}; },
      progress: event => { assertAccess(); context.progress(event); },
      ...(module.verifyBrowserTask ? {verify:async(observation:unknown,signal:AbortSignal) => {assertAccess();const verified = await module.verifyBrowserTask!(context.goal,observation,signal);assertAccess();signal.throwIfAborted();independentlyVerified=verified===true;return independentlyVerified;}} : {}),
      ...(module.resolveFieldText ? {resolveFieldText:async(request:unknown,signal:AbortSignal) => {assertAccess();const text = await module.resolveFieldText!(request,signal);assertAccess();return text;}} : {}),
    }, context.signal);
    if (result.status === 'succeeded') {
      assertAccess();
      if (!independentlyVerified || context.signal.aborted) return {...result,status:'needs_verification',reason:'VERIFICATION_FAILED'};
    }
    return result;
  } finally { await client.close().catch(() => {}); }
}

/** Stable binding objects allow live config replacement/revocation to fence active requests. */
export class BrowserConnectorRegistry {
  private cache = new Map<string,{signature:string;binding:BrowserTaskBinding}>();
  constructor(private readonly getConfig: () => BrowserIntegrationConfig | undefined, private readonly agentId: string) {}
  bindings(): BrowserTaskBinding[] {
    const config = this.getConfig();
    validateBrowserIntegration(config);
    const current = new Map<string,{signature:string;binding:BrowserTaskBinding}>();
    for (const b of config?.bindings ?? []) {
      if (b.agentId !== this.agentId) continue;
      const signature = JSON.stringify([config!.runnerModule,b]);
      let item = this.cache.get(b.id);
      if (item?.signature !== signature) {
        const snapshot = structuredClone(b), modulePath = config!.runnerModule;
        item = {signature,binding:{version:1,id:b.id,name:b.name,principalId:b.principalId,conversationId:b.conversationId,
          run:context => executeBrowserModule(modulePath,snapshot,context)}};
      }
      current.set(b.id,item);
    }
    this.cache = current;
    return [...current.values()].map(x=>x.binding);
  }
}
