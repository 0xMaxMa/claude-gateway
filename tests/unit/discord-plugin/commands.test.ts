import { SLASH_COMMANDS } from '../../../mcp/tools/discord/commands';

describe('SLASH_COMMANDS', () => {
  it('DC1: all commands have name and description', () => {
    for (const cmd of SLASH_COMMANDS) {
      expect(typeof cmd.name).toBe('string');
      expect(cmd.name.length).toBeGreaterThan(0);
      expect(typeof cmd.description).toBe('string');
      expect(cmd.description.length).toBeGreaterThan(0);
    }
  });

  it('DC2: /ask command has required question option', () => {
    const ask = SLASH_COMMANDS.find(c => c.name === 'ask');
    expect(ask).toBeDefined();
    const questionOpt = ask!.options?.find(o => o.name === 'question');
    expect(questionOpt).toBeDefined();
    expect(questionOpt!.required).toBe(true);
  });

  it('defines exactly 4 slash commands', () => {
    expect(SLASH_COMMANDS).toHaveLength(4);
    const names = SLASH_COMMANDS.map(c => c.name);
    expect(names).toContain('ask');
    expect(names).toContain('session');
    expect(names).toContain('new');
    expect(names).toContain('model');
  });
});
