#!/usr/bin/env node
/**
 * Mock claude for API sessions that records how it was spawned. Appends one
 * JSON line {pid, cwd, argv} to $MOCK_CLAUDE_ARGV_LOG, then answers every
 * stream-json user turn with a result, including the history-carrying turn a
 * respawn sends (mock-claude-api.js stays silent on that one).
 */
const fs = require('fs');
const readline = require('readline');

if (process.env.MOCK_CLAUDE_ARGV_LOG) {
  fs.appendFileSync(
    process.env.MOCK_CLAUDE_ARGV_LOG,
    JSON.stringify({ pid: process.pid, cwd: process.cwd(), argv: process.argv.slice(2) }) + '\n',
  );
}

readline.createInterface({ input: process.stdin, terminal: false }).on('line', (line) => {
  if (!line.trim()) return;
  process.stdout.write(JSON.stringify({ type: 'result', result: `[mock-claude-argv] cwd ${process.cwd()}` }) + '\n');
});

process.on('SIGTERM', () => process.exit(0));
process.stdin.resume();
