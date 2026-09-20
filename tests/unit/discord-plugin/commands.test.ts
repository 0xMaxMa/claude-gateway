import {commandDefinitions} from '../../../mcp/tools/discord/commands';
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

  it('registers session commands, help and model selection without duplicates', () => {
    expect(new Set(SLASH_COMMANDS.map(c=>c.name)).size).toBe(SLASH_COMMANDS.length);
    for(const command of ['help','restart','sessions','models']) expect(SLASH_COMMANDS.some(c=>c.name===command)).toBe(true);
    const names = SLASH_COMMANDS.map(c => c.name);
    expect(names).toContain('ask');
    expect(names).toContain('session');
    expect(names).toContain('new');
    expect(names).toContain('model');
    expect(names).toContain('clear');
    expect(names).toContain('compact');
  });
});

test('orchestration voice/task commands and CLI are registered only in supported modes',()=>{
 const names=(orch:boolean,interactive:boolean)=>commandDefinitions(orch,interactive).map(c=>c.name);
 expect(names(true,false)).toEqual(expect.arrayContaining(['voice','voices','tasks','stop']));expect(names(true,false)).not.toContain('cli');
 expect(names(false,false)).not.toEqual(expect.arrayContaining(['voice','voices','tasks']));expect(names(false,true)).toContain('cli');
});
