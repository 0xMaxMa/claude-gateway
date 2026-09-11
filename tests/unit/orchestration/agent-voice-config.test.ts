import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { migrateAgentVoiceConfig, applyGatewayOrchestration } from '../../../src/orchestration/gateway-config';
import { resolveOrchestrationConfig } from '../../../src/orchestration/config';
import { loadConfig } from '../../../src/config/loader';
import { ConfigWatcher } from '../../../src/config/watcher';
import { withConfigWriteLock } from '../../../src/config/config-write-lock';
import { applyMigration } from '../../../src/config/migrator';
import type { AgentConfig, GatewayConfig } from '../../../src/types';

const agent = (id: string): AgentConfig => ({ id, workspace: '/tmp/workspace', description: '', env: '', claude: { model: 'fixture', extraFlags: [] } });
const legacy = () => ({ gateway: { headless: true, orchestration: { enabled: true,
  tasks: { workerIdleTtlMs: 555000 }, voice: { enabled: true, language: 'ja', tts: { voiceId: 'shared' }, notes: { replyWithVoice: false } } } },
  agents: [agent('a'), { ...agent('b'), orchestration: { tasks: { workerIdleTtlMs: 222000 }, voice: { enabled: false, tts: { voiceId: 'private' }, notes: { replyWithVoice: false } } } }] });

test('materializes existing settings, preserves agent overrides, and never shares nested objects', () => {
  const doc: any = legacy();
  expect(migrateAgentVoiceConfig(doc)).toBe(true);
  expect(doc.gateway.orchestration).toBe(true);
  expect(doc.agents[0].voice).toMatchObject({ enabled: true, language: 'ja', tts: { provider: 'elevenlabs', model: 'eleven_v3_conversational', voiceId: 'shared' }, notes: { replyWithVoice: true } });
  expect(doc.agents[1].voice).toMatchObject({ enabled: false, tts: { voiceId: 'private' }, notes: { replyWithVoice: false } });
  expect(doc.agents.map((a: any) => a.orchestration.tasks.workerIdleTtlMs)).toEqual([555000, 222000]);
  for (const a of doc.agents) expect(a.orchestration).not.toHaveProperty('voice');
  doc.agents[0].voice.tts.voiceId = 'changed';
  expect(doc.agents[1].voice.tts.voiceId).toBe('private');
  const serialized = JSON.stringify(doc);
  expect(migrateAgentVoiceConfig(doc)).toBe(false);
  expect(JSON.stringify(doc)).toBe(serialized);
  doc.agents.push(agent('new'));
  applyGatewayOrchestration(doc.agents[2], doc);
  expect(doc.agents[2].voice).toBeUndefined();
  expect(resolveOrchestrationConfig(doc.agents[2].orchestration, {}).voice).toMatchObject({ enabled: false, tts: { provider: '', model: '', voiceId: '' } });
});

test('explicit new fields win over legacy fields, and gateway false remains false', () => {
  const doc: any = legacy(); doc.gateway.orchestration.enabled = false;
  doc.agents[0].voice = { enabled: false, tts: { voiceId: 'new-position' } };
  migrateAgentVoiceConfig(doc);
  expect(doc.gateway.orchestration).toBe(false);
  expect(doc.agents[0].voice).toMatchObject({ enabled: false, tts: { voiceId: 'new-position', model: 'eleven_v3_conversational' } });
});

test('loader persists raw migration once, protects backup and hot-reloads only the changed agent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-voice-migration-')), file = join(dir, 'config.json');
  try {
    const raw = legacy(); writeFileSync(file, JSON.stringify(raw));
    const before = loadConfig(file);
    expect(JSON.parse(readFileSync(file, 'utf8')).gateway.orchestration).toBe(true);
    expect(JSON.parse(readFileSync(file + '.before-agent-voice.bak', 'utf8'))).toEqual(raw);
    const saved = readFileSync(file, 'utf8'); loadConfig(file); expect(readFileSync(file, 'utf8')).toBe(saved);
    const updated = JSON.parse(saved); updated.agents[0].voice.enabled = false;
    writeFileSync(file, JSON.stringify(updated)); const after = loadConfig(file);
    const watcher = new ConfigWatcher(file, before, { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any);
    const changes = (watcher as any).diffConfig(before, after).fieldChanges;
    expect(changes).toContainEqual(expect.objectContaining({ agentId: 'a', field: 'voice', hotReloadable: true }));
    expect(changes.some((c: any) => c.agentId === 'b')).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('migration queued behind an API writer preserves its latest changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-voice-lock-')), file = join(dir, 'config.json');
  try {
    const raw = legacy(); writeFileSync(file, JSON.stringify(raw));
    let release!: () => void; const hold = new Promise<void>(r => { release = r; });
    const pending = withConfigWriteLock(file, async () => { await hold; writeFileSync(file, JSON.stringify({ ...raw, extra: 'keep' })); });
    loadConfig(file); release(); await pending; await withConfigWriteLock(file, () => {});
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.extra).toBe('keep'); expect(saved.gateway.orchestration).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('template migration does not insert voice off before preserving old enabled settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-voice-template-')), file = join(dir, 'config.json');
  try {
    const raw: any = legacy(); writeFileSync(file, JSON.stringify(raw));
    applyMigration(file, raw, { gateway: { orchestration: false }, agents: [{ ...agent('a'), voice: { enabled: false } }] }, '1.0.33');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.gateway.orchestration).toBe(true); expect(saved.agents[0].voice.enabled).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('new voice settings require models when enabled and never enable orchestration', () => {
  expect(() => resolveOrchestrationConfig({}, { enabled: true })).toThrow();
  const a = agent('new'); a.voice = { enabled: false };
  applyGatewayOrchestration(a, { gateway: { orchestration: false } } as GatewayConfig);
  expect(a.orchestration?.enabled).toBe(false);
  expect(resolveOrchestrationConfig(a.orchestration, a.voice).voice.enabled).toBe(false);
});

test('an invalid legacy agent does not prevent valid agents from migrating', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-voice-invalid-')), file = join(dir, 'config.json');
  try {
    const raw: any = legacy(); raw.agents.push({ ...agent('invalid'), orchestration: { voice: { typo: true } } });
    writeFileSync(file, JSON.stringify(raw));
    const result = loadConfig(file);
    expect(result.agents.map(a => a.id)).toEqual(['a', 'b']);
    expect(result.agents[0].voice?.enabled).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('disabled unconfigured legacy voice does not invent provider, model, or voice selections', () => {
  const doc: any = { gateway: { orchestration: { enabled: true, voice: { enabled: false } } }, agents: [agent('a')] };
  migrateAgentVoiceConfig(doc);
  expect(doc.agents[0].voice).toMatchObject({ enabled: false });
  expect(doc.agents[0].voice).not.toHaveProperty('tts');
  expect(resolveOrchestrationConfig({}, doc.agents[0].voice).voice.tts).toEqual({provider: '', model: '', voiceId: ''});
});

test('disabled explicitly configured voice preserves its provider and model on upgrade', () => {
  const doc: any = { gateway: { orchestration: { enabled: true, voice: { enabled: false, tts: { provider: 'upstream', model: 'eleven_v3', voiceId: 'saved' } } } }, agents: [agent('a')] };
  migrateAgentVoiceConfig(doc);
  expect(doc.agents[0].voice.tts).toEqual({provider: 'upstream', model: 'eleven_v3', voiceId: 'saved'});
});
