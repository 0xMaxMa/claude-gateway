import { Router, Request } from 'express';
import { createHash } from 'crypto';
import { AgentConfig, GatewayConfig, ApiKey } from '../types';
import { canWriteAgent, canAccessAgent, createApiAuthMiddleware } from './auth';
import { gatewayJev, jevAllowed } from '../orchestration/jev-gateway';
import { JevError, JevRequest } from '../jev/types';

/** Evaluation is a paid action. An API key must have write access to its agent. */
export function createJevRouter(config: GatewayConfig, agents: Map<string, AgentConfig>): Router {
  const router=Router();
  router.use('/v1/jev', (req,res,next)=>createApiAuthMiddleware(config.gateway.api?.keys ?? [])(req,res,next));
  const allowed=(req:Request,agentId:string,write:boolean) => {
    const key=(req as Request & {apiKey?: ApiKey}).apiKey;
    const current=key && config.gateway.api?.keys.find(k=>k.key===key.key);
    return Boolean(current && (write?canWriteAgent(current,agentId):canAccessAgent(current,agentId)));
  };
  router.post('/v1/jev/evaluate', async(req,res)=>{
    const body=req.body;
    const agent=typeof body?.agentId==='string' ? agents.get(body.agentId) : undefined;
    if(!agent || !allowed(req,agent.id,true)){res.status(403).json({error:'ACCESS_DENIED'});return;}
    if(!body || Object.keys(body).some(key=>!['agentId','state','questions','requestId'].includes(key))){res.status(400).json({error:'INVALID_REQUEST'});return;}
    const controller=new AbortController();
    const onClose=()=>{if(!res.writableFinished)controller.abort();};res.once('close',onClose);
    try {
      const principalId=createHash('sha256').update((req as Request & {apiKey: ApiKey}).apiKey.key).digest('hex');
      const requestId=typeof body.requestId==='string' ? createHash('sha256').update(JSON.stringify([principalId,agent.id,body.requestId])).digest('hex') : undefined;
      if(body.requestId!==undefined && (typeof body.requestId!=='string'||body.requestId.length>256)) throw new JevError('INVALID_REQUEST','Invalid request ID.');
      const result=await gatewayJev(config).service.evaluate({state:body.state,questions:body.questions,...(requestId ? {requestId} : {})} as JevRequest, {
        principalId,agentId:agent.id,consumer:'api',signal:controller.signal,
        authorize:()=>allowed(req,agent.id,true)&&agents.has(agent.id)&&jevAllowed(config,agents.get(agent.id)!)
      });
      if(!controller.signal.aborted)res.json(result);
    } catch(error){
      if(controller.signal.aborted)return;
      const e=error instanceof JevError?error:new JevError('PROVIDER_UNAVAILABLE','Jev evaluation unavailable.');
      res.status(e.code==='ACCESS_DENIED'?403:e.code==='AUTHENTICATION_FAILED'?502:e.code==='INVALID_REQUEST'?400:e.code==='REQUEST_CONFLICT'?409:e.code==='QUOTA_EXCEEDED'?402:e.code==='RATE_LIMITED'||e.code==='QUEUE_FULL'?429:e.code==='DEADLINE_EXCEEDED'?504:503).json({error:{code:`JEV_${e.code}`,message:e.message,...e.metadata}});
    } finally {res.off('close',onClose);}
  });
  router.get('/v1/jev/usage',(req,res)=>{
    const agentId=typeof req.query.agentId==='string'?req.query.agentId:'';
    if(!agents.has(agentId)||!allowed(req,agentId,false)){res.status(403).json({error:'ACCESS_DENIED'});return;}
    const limit=req.query.limit===undefined?50:Number(req.query.limit),offset=req.query.offset===undefined?0:Number(req.query.offset);
    if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0){res.status(400).json({error:'INVALID_PAGE'});return;}
    res.setHeader('Cache-Control','no-store');res.json(gatewayJev(config).history(agentId,limit,offset));
  });
  return router;
}
