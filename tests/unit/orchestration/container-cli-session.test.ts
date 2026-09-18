jest.mock('../../../src/orchestration/container',()=>({validateContainer:jest.fn(async()=>{}),containerNode:jest.fn()}));
import { AgentCliSessions, containerTranscriptCheckpoint } from '../../../src/orchestration/agent-cli-session';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { containerNode, validateContainer } from '../../../src/orchestration/container';
import { AgentConfig } from '../../../src/types';
const agent={type:'app-agent',container:'app-test',workspace:'/host/workspace'} as AgentConfig;
beforeEach(()=>jest.clearAllMocks());
test('container resume survives gateway restart and explicitly falls back after its transcript disappears',async()=>{
 const store=new OrchestrationStore(':memory:','a');
 try {
  const first=await new AgentCliSessions(store).resolveContainer('s',agent);
  expect(first.resume).toBe(false);
  (containerNode as jest.Mock).mockResolvedValueOnce('present').mockResolvedValueOnce('missing');
  expect(await new AgentCliSessions(store).resolveContainer('s',agent)).toEqual({id:first.id,resume:true});
  const next=await new AgentCliSessions(store).resolveContainer('s',agent);
  expect(next).toMatchObject({resume:false,fallback:'TRANSCRIPT_UNAVAILABLE'});
  expect(next.id).not.toBe(first.id);
  expect(containerNode).toHaveBeenCalledWith('app-test',expect.stringContaining("'-workspace'"),[first.id,expect.any(String)]);
  expect(validateContainer).toHaveBeenCalledTimes(3);
 } finally {store.close();}
});
test('Docker probe failure preserves mapping instead of silently falling back to host or a new session',async()=>{
 const store=new OrchestrationStore(':memory:','a'),sessions=new AgentCliSessions(store);
 try {
  const first=await sessions.resolveContainer('s',agent);
  (containerNode as jest.Mock).mockRejectedValueOnce(new Error('Docker unavailable'));
  await expect(sessions.resolveContainer('s',agent)).rejects.toThrow('Docker unavailable');
  expect(store.get('SELECT cli_session_id FROM agent_cli_sessions WHERE session_id=?','s')?.cli_session_id).toBe(first.id);
 }finally{store.close();}
});
test('the container checkpoint script actually executes and preserves real output',async()=>{
 const root=mkdtempSync(join(tmpdir(),'container-checkpoint-')),dir=join(root,'projects','-workspace'),file=join(dir,'fixture.jsonl');
 mkdirSync(dir,{recursive:true});writeFileSync(file,'{"type":"user","message":{"content":"original"}}\n');
 (containerNode as jest.Mock).mockImplementation(async(_container,script,args)=>execFileSync(process.execPath,['-e',script,...args],{env:{...process.env,CLAUDE_CONFIG_DIR:root},encoding:'utf8'}));
 try {
  const undo=await containerTranscriptCheckpoint('app-test','fixture');
  appendFileSync(file,'{"type":"user","message":{"content":"retry"}}\n');
  expect(await undo!()).toBe(true);
  expect(readFileSync(file,'utf8')).not.toContain('retry');
  const keep=await containerTranscriptCheckpoint('app-test','fixture');
  appendFileSync(file,'{"type":"assistant","message":{"model":"real","content":[{"type":"text","text":"answer"}]}}\n');
  expect(await keep!()).toBe(false);
  expect(readFileSync(file,'utf8')).toContain('answer');
 }finally{rmSync(root,{recursive:true,force:true});}
});
