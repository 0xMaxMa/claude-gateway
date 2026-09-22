import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { SessionStore } from '../../../src/session/store';
import { HistoryDB } from '../../../src/history/db';
import type { SessionProcess } from '../../../src/session/process';
import type { AgentConfig, GatewayConfig } from '../../../src/types';

// Identity resolution is separately tested; these runtimes represent two agents
// that actually use the same endpoint/account/model.
jest.mock('../../../src/orchestration/provider-scope',()=>({resolveProviderScope:()=> 'shared-fixture-account'}));

test('new report IDs across runtimes cannot bypass outage admission; pending media survives and cleanup remains safe',async()=>{
  const root=mkdtempSync(join(tmpdir(),'provider-runtime-'));
  const sessions=new SessionStore(root), runtimes:AgentOrchestrationRuntime[]=[], histories:HistoryDB[]=[];
  let starts=0, fail=true;
  const release=jest.fn(async()=>{});
  const scope=(id:string,session:string)=>({agentId:id,agentSessionId:session,source:'api' as const,accountId:'owner',chatId:session,threadKey:'',principalId:'owner'});
  try {
    for(const id of ['one','two']) {
      const dir=join(root,id),workspace=join(dir,'workspace');mkdirSync(workspace,{recursive:true});writeFileSync(join(workspace,'CLAUDE.md'),'Fixture identity');
      const agent={id,description:'fixture',env:'',workspace,claude:{model:'fixture',extraFlags:[]}} as AgentConfig;
      const gateway={gateway:{orchestration:true,headless:true},agents:[agent]} as GatewayConfig;
      const history=HistoryDB.forAgent(root,id);histories.push(history);
      runtimes.push(await AgentOrchestrationRuntime.open(agent,gateway,dir,sessions,history,{
        releaseAgentSession:release,
        createAgentSession:async(_session,profile)=>Object.assign(new EventEmitter(),{runtimeProfile:profile,
          start:async()=>{starts++;},stop:async()=>{},interrupt:()=>{},sendMessage:function(this:EventEmitter){
            this.emit('output',JSON.stringify(fail?{type:'result',is_error:true,errors:[{type:'server_error',status:503}]}:{type:'result',result:'Recovered'}));
          }}) as unknown as SessionProcess,
      }));
    }
    const sid=[randomUUID(),randomUUID()];
    for(let i=0;i<3;i++) {
      const n=i%2,id=n?'two':'one';await sessions.ensureApiSession(id,sid[n],sid[n]);
      await expect(runtimes[n].send({scope:scope(id,sid[n]),text:'Report progress',storeUserMessage:false,ingressKey:'notification:fresh-'+i},
        {execute:false,writeMemory:false},{timeoutMs:1000})).rejects.toMatchObject({code:'PROVIDER_UNAVAILABLE'});
    }
    expect(starts).toBe(3);
    for(let i=3;i<15;i++) await runtimes[1].send({scope:scope('two',sid[1]),text:'Report progress',storeUserMessage:false,ingressKey:'notification:fresh-'+i},
      {execute:false,writeMemory:false},{timeoutMs:1000});
    await runtimes[1].send({scope:scope('two',sid[1]),text:'Keep these files',attachmentIds:['fixture-image','fixture-audio'],metadata:{senderId:'owner',repliedMessageId:'quoted'},ingressKey:'user-media'},
      {execute:false,writeMemory:false},{timeoutMs:1000});
    expect(starts).toBe(3);
    const saved=runtimes[1].store.get("SELECT * FROM conversation_inputs WHERE text='Keep these files'")!;
    expect(saved.status).toBe('accepted');expect(JSON.parse(String(saved.attachment_refs_json))).toEqual(['fixture-image','fixture-audio']);
    expect(JSON.parse(String(saved.ingress_json))).toMatchObject({metadata:{senderId:'owner',repliedMessageId:'quoted'},capabilities:{execute:false,writeMemory:false}});
    expect(runtimes[1].store.all('SELECT * FROM tasks')).toHaveLength(0);
    expect(runtimes[1].store.get("SELECT COUNT(*) n FROM conversation_decisions WHERE state='failed'")?.n).toBe(1);
    expect(runtimes[1].stopResponse(sid[1])).toBe(true);

    // A separate healthy identity/administrative bypass exercises the runtime's
    // mandatory process release even if provider lease cleanup fails.
    fail=false;
    (runtimes[0] as any).config.providerAdmission.enabled=false;
    const leaseRelease=jest.spyOn((runtimes[0] as any).providerAdmission,'release').mockImplementation(()=>{throw new Error('fixture storage busy');});
    const before=release.mock.calls.length;
    await expect(runtimes[0].send({scope:scope('one',sid[0]),text:'Health fixture'},{execute:false,writeMemory:false},{timeoutMs:1000})).resolves.toBe('Recovered');
    expect(release.mock.calls.length).toBe(before+1);expect(runtimes[0].isBusy(sid[0])).toBe(false);
    leaseRelease.mockRestore();
  } finally {
    for(const runtime of runtimes) await runtime.close();
    for(const history of histories) (history as any).db.close();
    for(const id of ['one','two']) HistoryDB.evict(root,id);
    rmSync(root,{recursive:true,force:true});
  }
});
