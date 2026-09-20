import { commandHelp } from '../../src/agent/command-help';
import { BUILTIN_COMMANDS } from '../../src/agent/builtin-commands';
import { CHAT_CHANNELS } from '../../src/history/types';
test.each([...CHAT_CHANNELS,'api'] as const)('%s help lists exactly the registered core commands',channel=>{
 const text=commandHelp(channel);
 for(const [command,definition] of Object.entries(BUILTIN_COMMANDS)) expect(text.includes(`/${command} —`)).toBe(definition.channels.includes(channel));
 expect(text).not.toContain('undefined');
});
test('mode-specific help does not advertise unsupported voice or API slash controls',()=>{
 expect(commandHelp('line',true)).toContain('/voice [on|auto|off]');
 expect(commandHelp('line',false)).not.toContain('/tasks');
 expect(commandHelp('wechat',true)).not.toContain('/voice');
 expect(commandHelp('api',true)).not.toMatch(/^\/tasks(?:\s|$)/m);
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
test('API catalog includes help and sessions and excludes channel-only commands', () => {
 const names=commandCatalog('api').map(c=>c.name);
 expect(names).toEqual(expect.arrayContaining(['/help','/sessions','/restart','/compact']));
 expect(names).not.toContain('/new'); expect(names).not.toContain('/rename');
});
