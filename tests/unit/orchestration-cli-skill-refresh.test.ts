jest.mock('../../src/session/worker-extensions', () => ({ discoverWorkerExtensions: jest.fn(async () => ({ skills: [], servers: {}, notices: [] })) }));
import { refreshCliSkillRegistry } from '../../src/orchestration/cli-skills';
import { resolveSkill } from '../../src/orchestration/skills';
import type { SkillRegistry } from '../../src/skills/loader';
import type { AgentConfig } from '../../src/types';

const agent = { id: 'a', workspace: '/tmp' } as AgentConfig;

test('a refresh keeps the previous CLI skills resolvable until the new list is ready', async () => {
  const registry: SkillRegistry = { skills: new Map(), cliSkills: [{ name: 'review-pr', description: 'Review a PR' }] };
  let finish!: (skills: { name: string; description: string }[]) => void;
  const refresh = refreshCliSkillRegistry(registry, agent, undefined, () => new Promise(resolve => { finish = resolve; }));
  // Ingress for a message received while CLI discovery is still running.
  expect(resolveSkill('/review-pr 567', 'telegram', registry)?.name).toBe('review-pr');
  finish([{ name: 'review-pr', description: 'Review a PR' }, { name: 'deploy', description: 'Deploy' }]);
  await refresh;
  expect(registry.cliSkills?.map(skill => skill.name)).toEqual(['review-pr', 'deploy']);
  expect(registry.cliDiscoveryError).toBeUndefined();
});

test('a failed CLI discovery reports the error without leaving a half-built list', async () => {
  const registry: SkillRegistry = { skills: new Map(), cliSkills: [{ name: 'old', description: '' }] };
  await refreshCliSkillRegistry(registry, agent, undefined, async () => { throw new Error('probe failed'); });
  expect(registry.cliSkills).toEqual([]);
  expect(registry.cliDiscoveryError).toBe('CLI_SKILL_DISCOVERY_UNAVAILABLE');
  await refreshCliSkillRegistry(registry, agent, undefined, async () => [{ name: 'new', description: '' }]);
  expect(registry.cliSkills?.map(skill => skill.name)).toEqual(['new']);
  expect(registry.cliDiscoveryError).toBeUndefined();
});
