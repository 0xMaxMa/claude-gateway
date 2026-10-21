import { commandHelp } from '../../src/agent/command-help';
import { BUILTIN_COMMANDS } from '../../src/agent/builtin-commands';
import { CHAT_CHANNELS } from '../../src/history/types';
test.each([...CHAT_CHANNELS,'api'] as const)('%s help lists exactly the registered core commands',channel=>{
 const text=commandHelp(channel);
 for(const [command,definition] of Object.entries(BUILTIN_COMMANDS)) expect(text.includes(`/${channel==='telegram'?definition.alias??command:command} —`)).toBe(definition.channels.includes(channel) && !definition.hidden);
 expect(text).not.toContain('undefined');
});
test('mode-specific help does not advertise unsupported voice or API slash controls',()=>{
 expect(commandHelp('line',true)).toContain('/voice [on|auto|off]');
 expect(commandHelp('line',false)).not.toContain('/tasks');
 expect(commandHelp('wechat',true)).not.toContain('/voice');
 expect(commandHelp('api',true)).not.toMatch(/^\/(?:voice|voices|orch)\b/m);
 expect(commandHelp('discord',true,true)).not.toContain('/cli');
 expect(commandHelp('telegram',true,true)).toContain('/cli');
});

import { commandCatalog } from '../../src/agent/command-help';
import { formatSessionStatus } from '../../src/agent/session-status';
test.each([...CHAT_CHANNELS,'api'] as const)('%s session shortcuts only advertise supported commands', channel => {
 const status = formatSessionStatus('session','Fixture','model',{text:'—',contextUsedPct:null},false,channel);
 const shortcuts = status.split('Commands: ')[1].split(' ');
 for(const shortcut of shortcuts) expect(commandCatalog(channel).some(c=>c.name===shortcut)).toBe(true);
 expect(shortcuts).toContain('/help');
});
test('API catalog includes the web commands and hides the ones that only answer or carry a token', () => {
 const names=commandCatalog('api').map(c=>c.name);
 expect(names).toEqual(expect.arrayContaining(['/help','/sessions','/restart','/compact','/models','/new','/rename','/tasks']));
 for (const hidden of ['/voice','/voices','/orch','/status','/start']) expect(names).not.toContain(hidden);
});

// Review of #591 (L7): /tasks was offered to every agent, also those without orchestration, where it only refuses.
test('API /tasks is listed only for an orchestration agent; the agent-free catalog says it needs one', () => {
  expect(commandHelp('api', false)).not.toMatch(/^\/tasks —/m);
  expect(commandHelp('api', true)).toContain('/tasks — View tasks');
  expect(commandCatalog('api', false).map(c => c.name)).not.toContain('/tasks');
  expect(commandCatalog('api').find(c => c.name === '/tasks')!.description).toContain('orchestration mode');
});

test('Telegram help describes /model as a current-model query and points to the private model picker', () => {
  const line = commandHelp('telegram').split('\n').find(l => l.startsWith('/model —'))!;
  expect(line).toBe('/model — Show the current model; view or select models in a direct message with /models');
  expect(commandHelp('discord')).toContain('/model — Show the model; change it in a private chat: /model [model ID]');
});

test('help says which commands confirm first', () => {
  for (const name of ['clear', 'compact', 'restart']) {
    expect(commandHelp('api')).toMatch(new RegExp(`^/${name} — .*; confirmation required$`, 'm'));
    expect(commandHelp('telegram')).toMatch(new RegExp(`^/${name} — .*; confirmation required$`, 'm'));
  }
  expect(commandHelp('discord')).not.toMatch(/^\/clear — .*confirmation/m);
  // Review of #591 (L16): Discord, LINE and Slack ask before /restart (and /compact) too.
  for (const channel of ['discord', 'line', 'slack'] as const) {
    expect(commandHelp(channel)).toMatch(/^\/restart — .*; confirmation required$/m);
    expect(commandHelp(channel)).toMatch(/^\/compact — .*; confirmation required$/m);
  }
});

test('session status labels a context measured on a different model separately (#576)', () => {
  const text = formatSessionStatus('s', 'N', 'configured-model', { text: '1K / 1M', contextUsedPct: 1, contextModel: 'observed-model' });
  expect(text).toContain('Model: configured-model');
  expect(text).toContain('Context measured on: observed-model');
  expect(formatSessionStatus('s', 'N', 'm', { text: '—', contextUsedPct: null, contextModel: 'm' })).not.toContain('Context measured on');
  // Ids are compared raw on purpose: the [1m] suffix selects a different context window.
  expect(formatSessionStatus('s', 'N', 'claude-sonnet-5-5[1m]', { text: '—', contextUsedPct: null, contextModel: 'claude-sonnet-5-5' })).toContain('Context measured on: claude-sonnet-5-5');
});

// Dev e2e of #591: Telegram links a tapped /pstack-setup only up to '-', and web did not have it.
test('pstack setup is listed in its tappable spelling on Telegram and on web', () => {
  expect(commandHelp('telegram')).toContain('/pstack_setup — Set up pstack for this agent with buttons');
  expect(commandHelp('telegram')).not.toContain('/pstack-setup');
  expect(commandHelp('api')).toContain('/pstack-setup — Show the pstack setup');
  expect(commandCatalog('api').map(c => c.name)).toContain('/pstack-setup');
});

// Dev e2e of #591: on the web /models only lists; the model picker or PUT .../model switches.
test('web help and the API command picker say how /models switches the model', () => {
  const web = commandHelp('api').split('\n').find(l => l.startsWith('/models —'))!;
  expect(web).toBe('/models — List the models; switch with the model picker or PUT /api/v1/agents/:agentId/model');
  expect(commandCatalog('api').find(c => c.name === '/models')!.description).not.toContain('select');
  expect(commandHelp('telegram')).toContain('/models — List and select a model');
});
