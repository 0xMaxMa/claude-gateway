#!/usr/bin/env node
/**
 * Mock Claude CLI for orchestration worker tests (stream-json on stdio).
 *
 * MOCK_WORKER_MODE=complete  answer each user turn with a final result.
 * MOCK_WORKER_MODE=hang      start a grandchild process, record its PID in
 *                            MOCK_WORKER_PIDFILE, report a running tool and
 *                            never finish, so only cancellation ends the tree.
 * MOCK_WORKER_ARGSFILE       if set, receives { args, promptFileBytes, promptFileMode }
 *                            as JSON (the prompt file as found at startup).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const readline = require('readline');

if (process.env.MOCK_WORKER_ARGSFILE) {
  const args = process.argv.slice(2), file = args[args.indexOf('--append-system-prompt-file') + 1];
  const prompt = args.includes('--append-system-prompt-file') ? fs.statSync(file) : undefined;
  fs.writeFileSync(process.env.MOCK_WORKER_ARGSFILE, JSON.stringify({ args, promptFileBytes: prompt ? prompt.size : 0, promptFileMode: prompt ? prompt.mode & 0o777 : 0 }));
}
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
readline.createInterface({ input: process.stdin, terminal: false }).on('line', line => {
  let parsed;
  try { parsed = JSON.parse(line); } catch { return; }
  if (parsed.type !== 'user') return;
  emit({ type: 'system', subtype: 'init', session_id: 'mock-worker', tools: ['Read', 'Bash'] });
  if (process.env.MOCK_WORKER_MODE === 'hang') {
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(process.env.MOCK_WORKER_PIDFILE, String(grandchild.pid));
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'sleep' } }] } });
    return;
  }
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Worker finished the task.' }] } });
  emit({ type: 'result', subtype: 'success', result: 'Worker finished the task.', usage: { input_tokens: 1, output_tokens: 1 } });
});
process.stdin.resume();
