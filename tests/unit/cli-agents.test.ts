import { WIZARD_CHANNELS, UPDATE_CHANNELS, parseGeneratedAgentsMd } from '../../src/cli/commands/agents';
import { PAIRING_CHANNELS } from '../../src/cli/commands/channels';

describe('agents CLI — channel tables', () => {
  it('every wizard channel is manageable via `agents update`', () => {
    for (const c of WIZARD_CHANNELS) {
      expect(UPDATE_CHANNELS[c]).toBeDefined();
    }
  });

  it('pairing (approve/deny) channels match the wizard connect channels — both are the code-based-token set today', () => {
    expect([...PAIRING_CHANNELS].sort()).toEqual([...WIZARD_CHANNELS].sort());
  });

  it('LINE and Slack require both credential fields together (paired, unlike telegram/discord)', () => {
    expect(UPDATE_CHANNELS.line.fields).toHaveLength(2);
    expect(UPDATE_CHANNELS.slack.fields).toHaveLength(2);
    expect(UPDATE_CHANNELS.telegram.fields).toHaveLength(1);
    expect(UPDATE_CHANNELS.discord.fields).toHaveLength(1);
  });
});

describe('parseGeneratedAgentsMd', () => {
  it('returns unfenced content starting at the first heading', () => {
    const out = parseGeneratedAgentsMd('# Agent: Alfred\n\nYou are Alfred.');
    expect(out).toBe('# Agent: Alfred\n\nYou are Alfred.');
  });

  it('strips a wrapping ```markdown fence', () => {
    const out = parseGeneratedAgentsMd('```markdown\n# Agent: Alfred\n\nYou are Alfred.\n```');
    expect(out).toBe('# Agent: Alfred\n\nYou are Alfred.');
  });

  it('prefers YAML front-matter start over a later heading', () => {
    const out = parseGeneratedAgentsMd('noise\n---\nname: Alfred\n---\n\n# Agent: Alfred');
    expect(out).toBe('---\nname: Alfred\n---\n\n# Agent: Alfred');
  });

  it('returns null when neither a heading nor front-matter is found', () => {
    expect(parseGeneratedAgentsMd('just some prose with no markers')).toBeNull();
  });
});
