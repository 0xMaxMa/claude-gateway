import { runtimeProfileArgs, type RuntimeProfile } from '../../../src/session/runtime-profile';

const profile: RuntimeProfile = {
  role: 'worker', hostExecution: true, mcpConfigPath: '/task/mcp.json', overlay: 'worker policy',
};
function tools(args: string[]): string { return args[args.indexOf('--tools') + 1]; }

describe('host worker execution tool policy', () => {
  it('keeps the complete native inventory for general or unspecified work', () => {
    expect(tools(runtimeProfileArgs(profile, []))).toBe('default');
  });
  it('enforces an explicit resolved set rather than silently loading all native schemas', () => {
    const args = runtimeProfileArgs({ ...profile, workerTools: ['Read', 'Bash', 'Skill'] }, []);
    expect(tools(args)).toBe('Read,Bash,Skill');
    // Native reduction does not remove connector configuration or task instructions.
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/task/mcp.json');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('worker policy');
  });
  it('honors an intentionally empty native tool set without broadening authority', () => {
    expect(tools(runtimeProfileArgs({ ...profile, workerTools: [] }, []))).toBe('');
  });
  it('preserves task skill plugins and checkpoint hooks with an explicit set', () => {
    const args = runtimeProfileArgs({ ...profile, workerTools: ['Read', 'Bash', 'Skill'],
      skillPluginDir: '/task/skill', checkpointCommand: 'node /task/checkpoint.js' }, []);
    expect(args[args.indexOf('--plugin-dir') + 1]).toBe('/task/skill');
    expect(args[args.indexOf('--settings') + 1]).toContain('/task/checkpoint.js');
  });
});
