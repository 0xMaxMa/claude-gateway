import type {Client} from '@modelcontextprotocol/sdk/client/index.js';
import type {BrowserScope} from './browser-contract';

/** Explicit user work can ask for consent before acquiring a lease. Never called for
 * observation/receipt recovery or for a retry after an uncertain page mutation. */
export async function requestBrowserConsent(client: Pick<Client,'listTools'|'callTool'>, scope: BrowserScope, signal: AbortSignal, authorized:()=>boolean, waiting:()=>void, now=Date.now): Promise<string | undefined> {
  const check=()=>{signal.throwIfAborted();if(!authorized())throw Error('ACCESS_DENIED');};
  check();
  const inventory=await client.listTools({}, {signal,timeout:10000});
  check();
  if(!inventory.tools.some(t=>t.name==='browser_request_access'))return;
  const deadline=now()+300000;
  while(now()<deadline){
    check();
    const reply=await client.callTool({name:'browser_request_access',arguments:{device_id:scope.device_id,grant_id:scope.grant_id,wait_ms:Math.min(45000,deadline-now())}},undefined,{signal,timeout:50000});
    check();
    const text=(reply.content as Array<{type:string;text?:string}>).filter(c=>c.type==='text').map(c=>c.text??'').join('');
    if(text.length>65536)return 'BROWSER_CONSENT_INVALID';
    let data;try{data=JSON.parse(text);}catch{return 'BROWSER_CONSENT_INVALID';}
    if(reply.isError)return 'BROWSER_CONSENT_UNAVAILABLE';
    if(data?.state==='approved')return;
    if(data?.state==='denied'||data?.state==='stopped')return 'BROWSER_CONSENT_DENIED';
    if(data?.state!=='pending')return 'BROWSER_CONSENT_INVALID';
    waiting();
    // The server long-polls. A short cancellation-aware backoff also bounds a relay
    // returning pending immediately, with no model calls and no repeated popup.
    await new Promise<void>((resolve,reject)=>{
      const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason);};
      const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},1000);
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    });
  }
  return 'BROWSER_CONSENT_TIMEOUT';
}
