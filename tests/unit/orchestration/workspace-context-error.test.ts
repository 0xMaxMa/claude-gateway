import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SessionProcess } from '../../../src/session/process';

test('missing workspace context fails with a public diagnostic before spawning', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'missing-context-'));
  const receiver = {runtimeProfile:{role:'agent'},agentConfig:{workspace,claude:{extraFlags:[]}},gatewayConfig:{gateway:{headless:true}}};
  try {
    expect(() => (SessionProcess.prototype as any).buildArgs.call(receiver, null, 'model')).toThrow(expect.objectContaining({code:'WORKSPACE_CONTEXT_MISSING'}));
    writeFileSync(join(workspace,'CLAUDE.md'),'identity');
    expect(() => (SessionProcess.prototype as any).buildArgs.call(receiver, null, 'model')).not.toThrow();
  } finally { rmSync(workspace,{recursive:true,force:true}); }
});
