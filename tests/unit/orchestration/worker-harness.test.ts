import { resolveWorkerHarness, validateWorkerHarness, validateWorkerModel } from '../../../src/orchestration/worker-harness';
import type { AgentConfig, GatewayConfig } from '../../../src/types';
const agent = { id: 'sample', description:'Sample', workspace:'/tmp/sample', env: '', claude: { model: 'gpt-example[1m]', extraFlags: [] } } as AgentConfig;
const gateway = {gateway: {logDir:'/tmp/logs',timezone:'UTC'}, agents: [agent]} as GatewayConfig;
describe('worker harness selection', () => {
  it('defaults GPT workers to Codex and other models to Claude', () => {
    expect(resolveWorkerHarness(agent, gateway, agent.claude.model).harness).toBe('codex');
    expect(resolveWorkerHarness(agent, gateway, 'claude-example').harness).toBe('claude');
    expect(resolveWorkerHarness(agent, {...gateway, gateway: {...gateway.gateway, workers: {harness: 'claude'}}}, agent.claude.model).harness).toBe('claude');
  });
  it('routes known GPT identities and honors explicit metadata for opaque aliases', () => {
    const g: GatewayConfig = {...gateway, gateway: {...gateway.gateway,workers: {harness:'auto'}, models:[{id:'opaque-alias',alias:'fast',label:'Example',contextWindow:1000,workerHarness:'codex',workerModel:'gpt-native'}]}};
    expect(resolveWorkerHarness(agent,g,'openai/gpt-example[1m]')).toEqual({harness:'codex',config:{model:'openai/gpt-example',contextWindow:1000000}});
    expect(resolveWorkerHarness(agent,g,'fast')).toEqual({harness:'codex',config:{model:'gpt-native',contextWindow:1000}});
    expect(resolveWorkerHarness(agent,g,'claude-example').harness).toBe('claude');
    expect(resolveWorkerHarness(agent,g,'unknown/gpt-example').harness).toBe('claude');
  });
  it('lets agents explicitly stay on Claude and merges provider settings by field', () => {
    const g: GatewayConfig = {...gateway,gateway:{...gateway.gateway,workers:{harness:'auto',codex:{baseUrl:'https://provider.example/v1',apiKeyEnv:'VOICELESS_KEY'}}}};
    expect(resolveWorkerHarness({...agent,workers:{harness:'claude'}},g,agent.claude.model).harness).toBe('claude');
    expect(resolveWorkerHarness({...agent,workers:{codex:{reasoningEffort:'high'}}},g,agent.claude.model).config).toMatchObject({baseUrl:'https://provider.example/v1',apiKeyEnv:'VOICELESS_KEY',reasoningEffort:'high'});
  });
  it.each([{harness:'typo'}, {codex:{apiKeyEnv:'literal-secret!'}}, {codex:{baseUrl:'https://user:password@example.com'}}, {codex:{baseUrl:'http://remote.example/v1'}}, {codex:{reasoningEffort:'guess'}}, {extra:true}])('rejects invalid or credential-bearing configuration %j', c => {
    expect(()=>validateWorkerHarness(c)).toThrow();
  });
  it('accepts explicit local test endpoints and rejects invalid metadata', () => {
    expect(()=>validateWorkerHarness({codex:{baseUrl:'http://127.0.0.1:1234/v1',apiKeyEnv:'OPENAI_API_KEY'}})).not.toThrow();
    expect(()=>validateWorkerModel({workerHarness:'bogus'} as any)).toThrow();
  });
});

it('preserves explicit context selection and leaves unspecified native defaults alone', () => {
  expect(resolveWorkerHarness(agent,gateway,'gpt-example[200k]').config).toMatchObject({model:'gpt-example',contextWindow:200000});
  expect(resolveWorkerHarness(agent,gateway,'gpt-example').config).not.toHaveProperty('contextWindow');
});
