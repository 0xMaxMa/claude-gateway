import * as crypto from 'crypto';

/**
 * User text from channels (Telegram etc.) is untrusted and goes into a PTY:
 * strip every C0 control char except \n and \t (notably ESC — a crafted
 * message must not be able to inject terminal key sequences), plus DEL.
 * \r is normalized to \n so it cannot submit the TUI input early.
 */
export function sanitizeUserText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

export interface TranslatedArgs {
  /** Args to pass to the real interactive `claude` binary. */
  claudeArgs: string[];
  /** Session UUID (generated unless --session-id was already present). */
  sessionId: string;
  /** Model name as passed by the gateway (for the init event). */
  model: string;
}

/** Headless-only flags the wrapper consumes (claude interactive must not see them). */
const CONSUME_FLAGS = new Set(['--print', '-p', '--verbose', '--include-partial-messages']);
/** Headless-only flags with a value — consume both tokens. */
const CONSUME_FLAGS_WITH_VALUE = new Set(['--input-format', '--output-format']);
/** Flags with a value that pass through to interactive claude. */
const PASS_FLAGS_WITH_VALUE = new Set(['--model', '--mcp-config', '--session-id', '--permission-mode']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Translate the arg vector the gateway builds for headless claude
 * (see SessionProcess.buildArgs) into args for interactive claude.
 * Unknown flags pass through so agentConfig.claude.extraFlags keeps working.
 */
export function translateArgs(argv: string[]): TranslatedArgs {
  const claudeArgs: string[] = [];
  let sessionId = '';
  let model = '';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (CONSUME_FLAGS.has(arg)) continue;
    if (CONSUME_FLAGS_WITH_VALUE.has(arg)) { i++; continue; }
    // Built-in below — consume here so it is never duplicated.
    if (arg === '--dangerously-skip-permissions') continue;
    if (PASS_FLAGS_WITH_VALUE.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      if (arg === '--model') model = value;
      if (arg === '--session-id') {
        if (!UUID_RE.test(value)) throw new Error(`--session-id is not a UUID: ${value}`);
        sessionId = value;
      }
      claudeArgs.push(arg, value);
      i++;
      continue;
    }
    claudeArgs.push(arg);
  }

  if (!sessionId) {
    sessionId = crypto.randomUUID();
    claudeArgs.push('--session-id', sessionId);
  }

  // Built-in: the wrapper always runs claude with permissions skipped,
  // matching the gateway's headless backend (no config flag anymore).
  claudeArgs.push('--dangerously-skip-permissions');

  return { claudeArgs, sessionId, model };
}
