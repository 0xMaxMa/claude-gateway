#!/usr/bin/env node
/**
 * Mock claude subprocess for API integration tests.
 *
 * Reads stream-json turns from stdin and outputs stream-json result events so
 * that AgentRunner.sendApiMessage() can capture responses immediately (no 2s
 * quiet-period wait).
 *
 * Behaviour:
 * - Ignores the initial activation / history prompt (contains "Channels mode is active")
 * - For every API channel turn, extracts the user message and responds with
 *   {"type":"result","result":"[mock-claude-api] response to: <message>"}
 * - Exits cleanly on SIGTERM
 */

const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  // Unwrap stream-json turn envelope
  let text = trimmed;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed.type === 'user' && parsed.message?.content?.[0]?.text) {
      text = parsed.message.content[0].text;
    }
  } catch {
    // not JSON — use raw line
  }

  // Skip the initial activation / history prompt
  if (
    text.includes('Channels mode is active') ||
    text.includes('Conversation history with this user')
  ) {
    return;
  }

  // Extract user message from the <channel source="api" ...> XML envelope
  // Format: <channel ...>\n<message>\n\n[SYSTEM: ...]\n</channel>
  const channelMatch = text.match(/<channel[^>]*>\n?([\s\S]*?)(?:\[SYSTEM:|$)/);
  const userMessage = channelMatch ? channelMatch[1].trim() : text;

  // Emit a stream-json result — sendApiMessage() resolves immediately on this
  process.stdout.write(
    JSON.stringify({ type: 'result', result: `[mock-claude-api] response to: ${userMessage}` }) +
      '\n',
  );
});

process.on('SIGTERM', () => {
  process.exit(0);
});

// Keep the process alive waiting for stdin
process.stdin.resume();
