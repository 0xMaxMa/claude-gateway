import { createHash } from 'crypto';
import { providerScopeFromInputs, ProviderScopeInputs, resolvedCodexProviderScope, nativeCodexConfigIdentity } from '../../src/orchestration/provider-scope';
import type { AgentConfig, GatewayConfig } from '../../src/types';

const agent = { id: 'one', description: 'fixture', env: '', workspace: '/workspace/one', claude: { model: 'claude-example[1m]', extraFlags: [] } } as AgentConfig;
const gateway = { gateway: {}, agents: [agent] } as GatewayConfig;
const input: ProviderScopeInputs = { env: {}, settings: { env: { ANTHROPIC_BASE_URL: 'https://provider.example/tenant-a', ANTHROPIC_AUTH_TOKEN: 'test-secret' } } };
const container = { ...agent, type: 'app-agent', container: 'one' } as AgentConfig;
const scope = (a = agent, i = input, model = agent.claude.model, role: 'agent' | 'worker' = 'agent', g = gateway) => providerScopeFromInputs(a, g, model, role, undefined, i);

describe('provider outage scope identity', () => {
  it('detects native custom environment credential rotation without exposing it', () => {
    const config = 'model_provider = "custom"\n[model_providers.custom]\nenv_key = "TENANT_CREDENTIAL"\n';
    const before = nativeCodexConfigIdentity(config, {TENANT_CREDENTIAL:'fixture-old'});
    expect(nativeCodexConfigIdentity(config, {TENANT_CREDENTIAL:'fixture-new'})).not.toBe(before);
    expect(before).not.toContain('fixture-old');
    expect(nativeCodexConfigIdentity(config, {TENANT_CREDENTIAL:'fixture-old',UNRELATED:'change'})).toBe(before);
  });
  it('keys resolved Codex identity by stable account, model, context and recovery generation', () => {
    const identity = { fingerprint: 'fixture-account-fingerprint', model: 'gpt-example', contextWindow: 1000000 };
    const first = resolvedCodexProviderScope(identity, 3);
    // Refreshing an access token preserves the native account fingerprint.
    expect(resolvedCodexProviderScope({ ...identity }, 3)).toBe(first);
    expect(resolvedCodexProviderScope({ ...identity, fingerprint: 'other-account' }, 3)).not.toBe(first);
    expect(resolvedCodexProviderScope({ ...identity, model: 'gpt-other' }, 3)).not.toBe(first);
    expect(resolvedCodexProviderScope({ ...identity, contextWindow: 200000 }, 3)).not.toBe(first);
    expect(resolvedCodexProviderScope(identity, 4)).not.toBe(first);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });
  it('matches explicit preadmission to the native credential fingerprint without URL normalization', () => {
    const baseUrl = 'https://responses.example'; // URL.toString() adds a slash; credentials() does not.
    const key = 'test-codex-key';
    const g = { ...gateway, gateway: { workers: { harness: 'codex', codex: { baseUrl, apiKeyEnv: 'TEST_PROVIDER_KEY' } } } } as GatewayConfig;
    const fingerprint = createHash('sha256').update(JSON.stringify([baseUrl, key])).digest('hex');
    const configured = providerScopeFromInputs(agent, g, 'gpt-example[1m]', 'worker', undefined, { env: { TEST_PROVIDER_KEY: key }, settings: null });
    const scoped = createHash('sha256').update(JSON.stringify([configured, 7])).digest('hex');
    expect(resolvedCodexProviderScope({ fingerprint, model: 'gpt-example', contextWindow: 1000000 }, 7)).toBe(scoped);
  });
  it('shares explicit container credentials across agents and roles without exposing identity', () => {
    const result = scope(container);
    expect(result).toMatch(/^[a-f0-9]{64}$/);
    expect(result).toBe(scope({ ...container, id: 'two', container: 'two', workspace: '/other' }, input, agent.claude.model, 'worker'));
    expect(result).not.toContain('test-secret');
    expect(result).not.toContain('provider.example');
  });
  it('separates endpoint paths, accounts, and context suffixes', () => {
    const original = scope(container);
    const changed = (patch: Record<string, string>) => ({ ...input, settings: { env: { ...(input.settings!.env as object), ...patch } } });
    expect(scope(container, changed({ ANTHROPIC_BASE_URL: 'https://provider.example/tenant-b' }))).not.toBe(original);
    expect(scope(container, changed({ ANTHROPIC_AUTH_TOKEN: 'other-secret' }))).not.toBe(original);
    expect(scope(container, input, 'claude-example')).not.toBe(original);
  });
  it('honors grouped settings credentials instead of merging another inherited key', () => {
    expect(scope(container, { ...input, env: { ANTHROPIC_API_KEY: 'different-identity' } })).toBe(scope(container));
    const malformed = { ...input, env: { ANTHROPIC_API_KEY: 'different-identity' }, settings: { env: { ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: 'https://provider.example/tenant-a' } } };
    expect(scope(container, malformed)).not.toBe(scope({ ...container, id: 'two' }, malformed));
  });
  it('does not merge unknown host identities or execution contexts', () => {
    expect(scope()).not.toBe(scope({ ...agent, id: 'two' }));
    expect(scope()).not.toBe(scope(agent, input, agent.claude.model, 'worker'));
    expect(scope()).not.toBe(scope({ ...agent, workspace: '/other' }));
    expect(scope()).toBe(scope()); // New notifications have no session-specific scope.
    expect(scope(agent, { ...input, nativeIdentity: 'changed-file' })).not.toBe(scope());
  });
  it('isolates multiple credential choices and alternate backend routes', () => {
    const multiple = { ...input, settings: { env: { ...(input.settings!.env as object), ANTHROPIC_API_KEY: 'second' } } };
    expect(scope(container, multiple)).not.toBe(scope({ ...container, id: 'two' }, multiple));
    const cloud = { ...input, env: { CLAUDE_CODE_USE_VERTEX: '1' } };
    expect(scope(container, cloud)).not.toBe(scope({ ...container, id: 'two' }, cloud));
  });
  it('applies Codex routing only to workers and preserves context tier', () => {
    const g = { ...gateway, gateway: { workers: { harness: 'codex', codex: { baseUrl: 'https://responses.example/v1', apiKeyEnv: 'TEST_PROVIDER_KEY' } } } } as GatewayConfig;
    const i = { ...input, env: { TEST_PROVIDER_KEY: 'codex-secret' } };
    const first = scope(agent, i, 'gpt-example[1m]', 'worker', g);
    expect(first).toBe(scope({ ...agent, id: 'two', workspace: '/other' }, i, 'gpt-example[1m]', 'worker', g));
    expect(first).not.toBe(scope(agent, i, 'gpt-example', 'worker', g));
    expect(first).not.toBe(scope(agent, i, 'gpt-example[1m]', 'agent', g));
    expect(first).not.toBe(scope(agent, { ...i, env: { TEST_PROVIDER_KEY: 'rotated' } }, 'gpt-example[1m]', 'worker', g));
  });
  it('keeps native Codex fallback per agent and rotates with native file identity', () => {
    expect(scope(agent, input, 'gpt-example', 'worker')).not.toBe(scope({ ...agent, id: 'two' }, input, 'gpt-example', 'worker'));
    expect(scope(agent, { ...input, nativeIdentity: 'old' }, 'gpt-example', 'worker')).not.toBe(scope(agent, { ...input, nativeIdentity: 'new' }, 'gpt-example', 'worker'));
  });
});
