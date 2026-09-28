import { EventEmitter } from 'events';
import { startProcessTurn } from '../../../src/orchestration/process-turn';
import type { SessionProcess } from '../../../src/session/process';
import { taskFailure } from '../../../src/orchestration/tasks/failure';

test('agent can inspect capability metadata without receiving a worker execution tool', async () => {
  const process = new EventEmitter() as SessionProcess;
  Object.assign(process,{runtimeProfile:{role:'agent'},start:async()=>{},stop:jest.fn(async()=>{}),sendMessage:()=>{
    process.emit('output',JSON.stringify({type:'system',subtype:'init',tools:['mcp__gateway__capabilities_list','mcp__gateway__task_spawn']}));
    process.emit('output',JSON.stringify({type:'result',result:'catalog read'}));
  }});
  await expect(startProcessTurn(process,'List capabilities',1000).result).resolves.toMatchObject({text:'catalog read'});
});

test.each([true, false])('host inventory inheritance is explicit: %s', async hostExecution => {
  const process = new EventEmitter() as SessionProcess;
  Object.assign(process, { runtimeProfile: { role: 'worker', hostExecution }, start: async () => {},
    stop: jest.fn(async () => {}), sendMessage: () => {
      process.emit('output', JSON.stringify({ type: 'system', subtype: 'init', tools: ['Bash', 'WebFetch', 'mcp__custom__tool'] }));
      process.emit('output', JSON.stringify({ type: 'result', result: 'done' }));
    } });
  const turn = startProcessTurn(process, 'task', 1000);
  if (hostExecution) await expect(turn.result).resolves.toMatchObject({ text: 'done' });
  else await expect(turn.result).rejects.toMatchObject({ code: 'PROFILE_INVENTORY_MISMATCH' });
});


test.each([true, false])('agent accepts only connector tools present in its spawned config: %s', async configured => {
  const process = new EventEmitter() as SessionProcess;
  Object.assign(process, {runtimeProfile:{role:'agent'},start:async()=>{},stop:jest.fn(async()=>{}),
    isSpawnedConnectorTool:(name:string)=>configured && name==='mcp__github__list_issues',
    sendMessage:()=>{
      process.emit('output',JSON.stringify({type:'system',subtype:'init',tools:['mcp__gateway__task_status','mcp__github__list_issues']}));
      process.emit('output',JSON.stringify({type:'result',result:'done'}));
    }});
  const turn=startProcessTurn(process,'task',1000);
  if(configured)await expect(turn.result).resolves.toMatchObject({text:'done'});
  else await expect(turn.result).rejects.toMatchObject({code:'PROFILE_INVENTORY_MISMATCH'});
});


test('the agent intake tool is accepted on every turn, whatever the feature state', async () => {
  // conversation_intake is declared unconditionally so the cached tools prefix stays
  // byte-identical, so the CLI reports it on every agent turn — including the turns where
  // semantic intake is inactive. Validating it against a per-turn feature flag rejected the
  // turn outright (PROFILE_INVENTORY_MISMATCH) exactly then; the bridge refuses the call
  // instead. The profile therefore carries no intake flag at all any more.
  const process = new EventEmitter() as SessionProcess;
  Object.assign(process, {runtimeProfile:{role:'agent'},start:async()=>{},stop:jest.fn(async()=>{}),
    sendMessage:()=>{
      process.emit('output',JSON.stringify({type:'system',subtype:'init',tools:['mcp__gateway__task_status','mcp__gateway__conversation_intake']}));
      process.emit('output',JSON.stringify({type:'result',result:'done'}));
    }});
  await expect(startProcessTurn(process,'task',1000).result).resolves.toMatchObject({text:'done'});
});

test('an agent still cannot receive a tool outside its declared inventory', async () => {
  const process = new EventEmitter() as SessionProcess;
  Object.assign(process, {runtimeProfile:{role:'agent'},start:async()=>{},stop:jest.fn(async()=>{}),
    sendMessage:()=>{
      process.emit('output',JSON.stringify({type:'system',subtype:'init',tools:['mcp__gateway__conversation_intake','mcp__gateway__task_stage_file']}));
      process.emit('output',JSON.stringify({type:'result',result:'done'}));
    }});
  await expect(startProcessTurn(process,'task',1000).result).rejects.toMatchObject({code:'PROFILE_INVENTORY_MISMATCH',rejectedTools:['mcp__gateway__task_stage_file']});
});

test('a container worker advertising an unauthorized tool is rejected before inference with the sanitized name (#548)', async () => {
  const process = new EventEmitter() as SessionProcess;
  Object.assign(process, {runtimeProfile:{role:'worker',containerExecution:true},start:async()=>{},stop:jest.fn(async()=>{}),
    sendMessage:()=>{
      process.emit('output',JSON.stringify({type:'system',subtype:'init',tools:['Bash','mcp__gateway__task_report_progress','mcp__gateway__task_spawn']}));
      process.emit('output',JSON.stringify({type:'result',result:'done'}));
    }});
  await expect(startProcessTurn(process,'task',1000).result).rejects.toMatchObject(
    {code:'PROFILE_INVENTORY_MISMATCH',inventoryKind:'unexpected',rejectedTools:['mcp__gateway__task_spawn']});
});

test('a valid container worker profile starts successfully under its declared native and MCP tools (#548)', async () => {
  const process = new EventEmitter() as SessionProcess;
  Object.assign(process, {runtimeProfile:{role:'worker',containerExecution:true},start:async()=>{},stop:jest.fn(async()=>{}),
    sendMessage:()=>{
      process.emit('output',JSON.stringify({type:'system',subtype:'init',tools:['Bash','Read','mcp__gateway__task_report_progress','mcp__gateway__task_stage_file']}));
      process.emit('output',JSON.stringify({type:'result',result:'done'}));
    }});
  await expect(startProcessTurn(process,'task',1000).result).resolves.toMatchObject({text:'done'});
});

test('missing and malformed container init inventories carry distinguishable diagnostics (#548)', async () => {
  const mk = (tools: unknown) => {
    const process = new EventEmitter() as SessionProcess;
    const init: any = {type:'system',subtype:'init'};
    if (tools !== undefined) init.tools = tools;
    Object.assign(process, {runtimeProfile:{role:'worker',containerExecution:true},start:async()=>{},stop:jest.fn(async()=>{}),
      sendMessage:()=>{ process.emit('output',JSON.stringify(init)); process.emit('output',JSON.stringify({type:'result',result:'done'})); }});
    return startProcessTurn(process,'task',1000).result;
  };
  // The kind is authoritative; missing/malformed carry no concrete rejected names, so rejectedTools
  // stays empty rather than duplicating the kind as a placeholder string (F4).
  await expect(mk(undefined)).rejects.toMatchObject({code:'PROFILE_INVENTORY_MISMATCH',inventoryKind:'missing',rejectedTools:[]});
  await expect(mk('not-a-list')).rejects.toMatchObject({code:'PROFILE_INVENTORY_MISMATCH',inventoryKind:'malformed',rejectedTools:[]});
});

test('a container init inventory list carrying a non-string element is classified malformed, not unexpected (#548)', async () => {
  // A non-string tool entry is a shape the CLI never emits — a protocol/parse fault, not a policy
  // violation — so it is 'malformed' (structurally invalid), reserving 'unexpected' for a
  // well-formed string list that names a tool outside the profile.
  const process = new EventEmitter() as SessionProcess;
  Object.assign(process, {runtimeProfile:{role:'worker',containerExecution:true},start:async()=>{},stop:jest.fn(async()=>{}),
    sendMessage:()=>{
      process.emit('output',JSON.stringify({type:'system',subtype:'init',tools:['Bash',42,'Read']}));
      process.emit('output',JSON.stringify({type:'result',result:'done'}));
    }});
  await expect(startProcessTurn(process,'task',1000).result).rejects.toMatchObject(
    {code:'PROFILE_INVENTORY_MISMATCH',inventoryKind:'malformed',rejectedTools:[]});
});

test('a rejected tool name embedding a credential is scrubbed at the source, before any consumer logs it (#548)', async () => {
  // The agent-path consumer (runtime.ts) persists and console.errors error.rejectedTools directly,
  // so the names must already be secret-scrubbed when the error is raised, not only in the task path.
  const old = process.env.TEST_INVENTORY_SECRET; process.env.TEST_INVENTORY_SECRET = 'supersecretcredentialvalue';
  try {
    const process_ = new EventEmitter() as SessionProcess;
    Object.assign(process_, {runtimeProfile:{role:'worker',containerExecution:true},start:async()=>{},stop:jest.fn(async()=>{}),
      sendMessage:()=>{
        process_.emit('output',JSON.stringify({type:'system',subtype:'init',tools:['Bash','mcp__leak__supersecretcredentialvalue']}));
        process_.emit('output',JSON.stringify({type:'result',result:'done'}));
      }});
    const error = await startProcessTurn(process_,'task',1000).result.catch((e: any) => e);
    expect(error.code).toBe('PROFILE_INVENTORY_MISMATCH');
    expect(JSON.stringify(error.rejectedTools)).not.toContain('supersecretcredentialvalue');
  } finally { if (old === undefined) delete process.env.TEST_INVENTORY_SECRET; else process.env.TEST_INVENTORY_SECRET = old; }
});


// Claude Code 2.1.283 advertises `GetTask` (the reader for Bash background-task output)
// alongside Bash whenever its rollout flag is on, so the same launch can report the tool on
// one run and omit it on the next. Captured `system/init.tools` from the app container with
// the gateway's container-worker args: ["Bash","Edit","GetTask","Glob","Grep","Read","Skill","Write"] (#552).
const initWith = (runtimeProfile: Record<string, unknown>, tools: string[]) => {
  const process = new EventEmitter() as SessionProcess;
  Object.assign(process, {runtimeProfile, start:async()=>{}, stop:jest.fn(async()=>{}),
    sendMessage:()=>{
      process.emit('output',JSON.stringify({type:'system',subtype:'init',tools}));
      process.emit('output',JSON.stringify({type:'result',result:'done'}));
    }});
  return startProcessTurn(process,'task',1000).result;
};
const OBSERVED_2_1_283 = ['Bash','Edit','GetTask','Glob','Grep','Read','Skill','Write'];

test.each([
  ['container', {role:'worker',containerExecution:true}],
  ['isolated', {role:'worker'}],
])('a %s worker whose default tools include Bash accepts the CLI Bash companion GetTask (#552)', async (_label, profile) => {
  await expect(initWith(profile, [...OBSERVED_2_1_283, 'mcp__gateway__task_report_progress'])).resolves.toMatchObject({text:'done'});
  // The flag-off inventory of the same launch still starts too.
  await expect(initWith(profile, OBSERVED_2_1_283.filter(name => name !== 'GetTask'))).resolves.toMatchObject({text:'done'});
});

test.each([
  ['container', {role:'worker',containerExecution:true,workerTools:['Read','Grep']}],
  ['isolated', {role:'worker',workerTools:['Read','Grep']}],
])('a %s worker without Bash still rejects an advertised GetTask (#552)', async (_label, profile) => {
  await expect(initWith(profile, ['Read','Grep','GetTask'])).rejects.toMatchObject(
    {code:'PROFILE_INVENTORY_MISMATCH',inventoryKind:'unexpected',rejectedTools:['GetTask']});
});

test('the Bash companion does not widen a container worker to other native tools (#552)', async () => {
  await expect(initWith({role:'worker',containerExecution:true}, [...OBSERVED_2_1_283,'TaskStop','Monitor','WebFetch'])).rejects.toMatchObject(
    {code:'PROFILE_INVENTORY_MISMATCH',inventoryKind:'unexpected',rejectedTools:['TaskStop','Monitor','WebFetch']});
});

test('an unexpected inventory is described as advertised outside the profile, never as a missing tool (#552)', async () => {
  const error = await initWith({role:'worker',containerExecution:true,workerTools:['Read']}, ['Read','GetTask']).catch(e => e);
  expect(error.message).toMatch(/advertised .*outside the resolved worker profile: GetTask/);
  expect(error.message).not.toMatch(/missing|lacks|unavailable/i);
  const failure = taskFailure(error);
  expect(failure).toMatchObject({code:'PROFILE_INVENTORY_MISMATCH',inventory:{kind:'unexpected',rejectedTools:['GetTask']}});
  expect(failure.message).toBe(error.message);
});

test('missing and malformed inventories keep distinct descriptions (#552)', async () => {
  const missing = await initWith({role:'worker',containerExecution:true}, undefined as unknown as string[]).catch(e => e);
  expect(missing.message).toMatch(/did not advertise a tool inventory/);
  const malformed = await initWith({role:'worker',containerExecution:true}, 'x' as unknown as string[]).catch(e => e);
  expect(malformed.message).toMatch(/malformed tool inventory/);
});
