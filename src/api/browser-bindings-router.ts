import { Router, Request } from 'express';
import { randomUUID, createHash } from 'crypto';
import { readFile } from 'fs/promises';
import type { AgentRunner } from '../agent/runner';
import type { GatewayConfig, ApiKey } from '../types';
import { createApiAuthMiddleware, isAdmin, canAccessAgent } from './auth';
import { apiPrincipal } from '../orchestration/identity';
import { withConfigWriteLock, writeConfigAtomic } from '../config/config-write-lock';
import { inspectBrowser, resolveBrowserConnection, validateBrowserIntegration } from '../jev/browser-connector';
import { JevError } from '../jev/types';
import { jevAllowed } from '../orchestration/jev-gateway';
import type { BrowserConnectorConfig, BrowserIntegrationConfig } from '../jev/browser-contract';

/** Binding administration uses existing admin auth. Session identity is derived, never caller supplied. */
export function createBrowserBindingsRouter(config:GatewayConfig,runners:Map<string,AgentRunner>,configPath?:string):Router {
  const router=Router();
  const base='/v1/agents/:agentId/sessions/:sessionId';
  router.use(base+'/browser-bindings', (req,res,next)=>createApiAuthMiddleware(config.gateway.api?.keys??[])(req,res,next));
  const currentKey=(req:Request)=>{
    const incoming=(req as Request & {apiKey:ApiKey}).apiKey;
    const key=config.gateway.api?.keys.find(k=>k.key===incoming?.key);
    if(!key || !canAccessAgent(key,req.params.agentId))throw Error('ACCESS_DENIED');
    return key;
  };
  const scope=async(req:Request,write=false)=>{
    const key=currentKey(req),runner=runners.get(req.params.agentId);
    if(!runner || (write&&!isAdmin(key)))throw Error('ACCESS_DENIED');
    const identity=await runner.browserSessionScope(req.params.sessionId,apiPrincipal(key));
    return {runner,identity,key};
  };
  const matches=(b:BrowserConnectorConfig,agentId:string,identity:{principalId:string;conversationId:string})=>b.agentId===agentId&&b.principalId===identity.principalId&&b.conversationId===identity.conversationId;
  const error=(res:import('express').Response,e:unknown)=>{
    const code=e instanceof Error?e.message:'';
    const publicCodes:Record<string,number>={BROWSER_RUNNER_NOT_CONFIGURED:409,CONFIG_PERSISTENCE_UNAVAILABLE:503,BROWSER_BINDING_EXISTS:409,BROWSER_EVIDENCE_INVALID:502,BROWSER_INSPECTION_DENIED:403,BROWSER_CONNECTOR_UNAVAILABLE:409,BROWSER_CONNECTOR_AUTH_UNSUPPORTED:409};
    return res.status(e instanceof JevError?400:publicCodes[code]??403).json({error:e instanceof JevError?'INVALID_BROWSER_BINDING':publicCodes[code]?code:'BROWSER_BINDING_UNAVAILABLE'});
  };
  const mutate=async(req:Request,fn:(b:BrowserIntegrationConfig,identity:{principalId:string;conversationId:string},disk:GatewayConfig)=>void)=>{
    if(!configPath)throw Error('CONFIG_PERSISTENCE_UNAVAILABLE');
    await withConfigWriteLock(configPath,async()=>{
      const {identity}=await scope(req,true);
      const disk=JSON.parse(await readFile(configPath,'utf8')) as GatewayConfig;
      const browser=disk.gateway.jev?.browser;
      if(!browser)throw Error('BROWSER_RUNNER_NOT_CONFIGURED');
      fn(browser,identity,disk);validateBrowserIntegration(browser);
      // Recheck the active API key after async disk reads. No model/provider work occurs here.
      if(!isAdmin(currentKey(req)))throw Error('ACCESS_DENIED');
      await writeConfigAtomic(configPath,disk);
      if(config.gateway.jev)config.gateway.jev.browser=browser;
    });
  };
  router.get(base+'/browser-bindings',async(req,res)=>{
    try {const {identity}=await scope(req);res.setHeader('Cache-Control','no-store');res.json({bindings:(config.gateway.jev?.browser?.bindings??[]).filter(b=>matches(b,req.params.agentId,identity)).map(b=>({id:b.id,name:b.name,connectorId:b.connectorId,scope:b.scope}))});}catch(e){error(res,e);}
  });
  router.post(base+'/browser-bindings',async(req,res)=>{
    try {
      const {runner,identity}=await scope(req,true),body=req.body;
      if(!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).some(k=>!['connectorId','name','scope'].includes(k)))throw new JevError('INVALID_CONFIG','Invalid binding.');
      if(!jevAllowed(config,runner.getAgentConfig()) || config.gateway.jev?.features?.browserTasks?.enabled!==true)throw Error('BROWSER_NOT_ALLOWED');
      const binding:BrowserConnectorConfig={id:randomUUID(),name:body.name,connectorId:body.connectorId,scope:body.scope,agentId:req.params.agentId,...identity};
      validateBrowserIntegration({runnerModule:config.gateway.jev?.browser?.runnerModule??'',bindings:[binding]});
      if(!binding.connectorId)throw new JevError('INVALID_CONFIG','Connector required.');
      const connection=resolveBrowserConnection(config,runner.getAgentConfig(),binding.connectorId);
      const fingerprint=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
      const connected=fingerprint(connection);
      const authorized=()=>{try{return isAdmin(currentKey(req))&&jevAllowed(config,runner.getAgentConfig())&&config.gateway.jev?.features?.browserTasks?.enabled===true&&connected===fingerprint(resolveBrowserConnection(config,runner.getAgentConfig(),binding.connectorId!));}catch{return false;}};
      // Read-only scope proof. Relay/extension, not a model's claimed ID, authorizes this tab.
      await inspectBrowser(binding,{status:'blocked',reason:'BINDING_CHECK',steps:0,evaluations:0},AbortSignal.timeout(30000),authorized,connection);
      await mutate(req,(browser,fresh,disk)=>{
        if(!authorized() || fresh.conversationId!==identity.conversationId || fresh.principalId!==identity.principalId)throw Error('ACCESS_DENIED');
        const agent=disk.agents.find(a=>a.id===binding.agentId);
        if(!agent || connected!==fingerprint(resolveBrowserConnection(disk,agent,binding.connectorId!)))throw Error('ACCESS_DENIED');
        if(browser.bindings.some(b=>matches(b,binding.agentId,fresh)&&b.connectorId===binding.connectorId&&(['device_id','grant_id','tab_id'] as const).every(k=>b.scope[k]===binding.scope[k])))throw Error('BROWSER_BINDING_EXISTS');
        browser.bindings.push(binding);
      });
      res.status(201).json({binding:{id:binding.id,name:binding.name,connectorId:binding.connectorId,scope:binding.scope}});
    }catch(e){error(res,e);}
  });
  router.delete(base+'/browser-bindings/:bindingId',async(req,res)=>{
    try {await mutate(req,(browser,identity)=>{
      const index=browser.bindings.findIndex(b=>b.id===req.params.bindingId&&matches(b,req.params.agentId,identity));
      if(index<0)throw Error('ACCESS_DENIED');browser.bindings.splice(index,1);
    });res.status(204).end();}catch(e){error(res,e);}
  });
  router.get(base+'/tasks/:taskId/browser-evidence',(req,res,next)=>createApiAuthMiddleware(config.gateway.api?.keys??[])(req,res,next),async(req,res)=>{
    try {const key=currentKey(req),runner=runners.get(req.params.agentId);if(!runner || (req.query.refresh!==undefined&&req.query.refresh!=='true'&&req.query.refresh!=='false'))throw Error('ACCESS_DENIED');
      res.setHeader('Cache-Control','no-store');const evidence=await runner.browserEvidence(req.params.sessionId,apiPrincipal(key),req.params.taskId,req.query.refresh==='true');currentKey(req);res.json(evidence);
    }catch{res.status(403).json({error:'BROWSER_EVIDENCE_UNAVAILABLE'});}
  });
  return router;
}
