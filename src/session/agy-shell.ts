#!/usr/bin/env node
/**
 * agy-shell — drives the Antigravity CLI (`agy`, native Gemini) while speaking
 * the gateway's headless stream-json protocol on stdio, so the gateway can run
 * `gemini/*` models with ZERO changes to the stdout parser or the runner reply
 * bridge (they keep consuming Claude-shaped stream-json lines).
 *
 * Drop-in usage (process.ts spawns this for gemini/* models):
 *   node dist/session/agy-shell.js
 * driven by env:
 *   AGY_BIN                 path to the agy binary (default: "agy" on PATH)
 *   AGY_MODEL               the gateway model id, e.g. "gemini/gemini-3.6-flash-low"
 *   AGY_PERSONA             custom-agent name to select (default "getpod")
 *   AGY_SYSTEM_PROMPT_FILE  file whose contents become the persona system prompt
 *   AGY_MCP_CONFIG_FILE     a {mcpServers:{…}} manifest to install for agy
 *
 * Protocol contract (what the gateway expects on our stdout, per turn):
 *   - optional partial  {type:'assistant', stop_reason:null, message:{content:[{type:'text',text:<cumulative>}]}}
 *   - exactly one final {type:'assistant', stop_reason:'end_turn', message:{content:[{type:'text',text:<full>}]}}
 *   - exactly one       {type:'result', is_error, result:<text>, usage:{output_tokens}}
 * The turn text arrives on stdin as {type:'user', message:{content:[{type:'text',text}]}}.
 *
 * agy is one-shot per turn (`agy -p <text>` exits), while the gateway assumes a
 * long-lived child fed turns over stdin — so this wrapper stays resident, reads
 * each stdin turn, spawns agy for it, and threads agy's conversation_id across
 * turns via --conversation for multi-turn continuity.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { spawn } from 'child_process';

// ---- pure translation core (unit-tested) -----------------------------------

export interface AgyTurnState {
  conversationId: string | null;
  partialText: string;
}

export interface TranslateResult {
  lines: string[]; // Claude-shaped stream-json lines to emit on stdout
  done: boolean; // true once the agy `result` event was seen (turn complete)
  conversationId: string | null; // updated conversation id to persist for the next turn
}

/** Build the Claude-shaped `assistant` line carrying `text`. */
export function claudeAssistantLine(text: string, final: boolean): string {
  return JSON.stringify({
    type: 'assistant',
    stop_reason: final ? 'end_turn' : null,
    message: { content: [{ type: 'text', text }] },
  });
}

/** Build the Claude-shaped `message_start` stream_event carrying input usage. */
export function claudeMessageStartLine(inputTokens: number, cacheReadTokens: number): string {
  return JSON.stringify({
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: {
        usage: {
          input_tokens: Math.max(0, inputTokens - cacheReadTokens),
          cache_read_input_tokens: cacheReadTokens,
          cache_creation_input_tokens: 0,
        },
      },
    },
  });
}

/** Build the Claude-shaped terminal `result` line. */
export function claudeResultLine(text: string, isError: boolean, outputTokens: number): string {
  return JSON.stringify({
    type: 'result',
    is_error: isError,
    result: text,
    usage: { output_tokens: outputTokens },
  });
}

/**
 * translateAgyEvent maps ONE parsed agy stream-json event into zero or more
 * Claude-shaped stdout lines, mutating `state` (cumulative partial text +
 * conversation id). Pure w.r.t. IO so it can be table-tested.
 *
 * agy events:
 *  - {event:'init', conversation_id, init:{model,tools,...}}
 *  - {event:'step_update', step_update:{step_type, state, text_delta?, usage?}}
 *      step_type 'agent_response' carries text_delta (progressive assistant text)
 *  - {event:'result', result:{status:'SUCCESS'|…, response, usage}}
 */
export function translateAgyEvent(evt: any, state: AgyTurnState): TranslateResult {
  const out: string[] = [];
  if (!evt || typeof evt !== 'object') {
    return { lines: out, done: false, conversationId: state.conversationId };
  }

  switch (evt.event) {
    case 'init': {
      if (typeof evt.conversation_id === 'string') {
        state.conversationId = evt.conversation_id;
      }
      return { lines: out, done: false, conversationId: state.conversationId };
    }
    case 'step_update': {
      const su = evt.step_update || {};
      if (typeof su.conversation_id === 'string') state.conversationId = su.conversation_id;
      // Progressive assistant text: agy emits a text_delta chunk. The gateway's
      // parser expects partials to carry the CUMULATIVE text, so accumulate.
      if (su.step_type === 'agent_response' && typeof su.text_delta === 'string' && su.text_delta.length > 0) {
        state.partialText += su.text_delta;
        out.push(claudeAssistantLine(state.partialText, false));
      }
      return { lines: out, done: false, conversationId: state.conversationId };
    }
    case 'result': {
      const r = evt.result || {};
      if (typeof r.conversation_id === 'string') state.conversationId = r.conversation_id;
      const text: string = typeof r.response === 'string' ? r.response : state.partialText;
      const isError = r.status !== undefined && r.status !== 'SUCCESS';
      const usage = r.usage || {};
      const inputTokens = Number(usage.input_tokens) || 0;
      const cacheRead = Number(usage.cache_read_tokens) || 0;
      const outputTokens = (Number(usage.output_tokens) || 0) + (Number(usage.thinking_tokens) || 0);
      if (inputTokens > 0) out.push(claudeMessageStartLine(inputTokens, cacheRead));
      out.push(claudeAssistantLine(text, true));
      out.push(claudeResultLine(text, isError, outputTokens));
      return { lines: out, done: true, conversationId: state.conversationId };
    }
    default:
      return { lines: out, done: false, conversationId: state.conversationId };
  }
}

/** Extract the plain text from a gateway {type:'user'} turn line. */
export function textFromUserTurn(line: string): string | null {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!obj || obj.type !== 'user' || !obj.message || !Array.isArray(obj.message.content)) return null;
  return obj.message.content
    .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('');
}

/** agy model id = the gateway id with the "gemini/" prefix stripped. */
export function agyModelId(gatewayModel: string): string {
  return gatewayModel.startsWith('gemini/') ? gatewayModel.slice('gemini/'.length) : gatewayModel;
}

// ---- runtime wiring (not unit-tested; thin IO shell) -----------------------

const GEMINI_CONFIG_DIR = path.join(os.homedir(), '.gemini', 'config');

/** Install the persona agent.md + mcp_config.json agy reads on startup. */
function installAgyConfig(persona: string): void {
  try {
    const promptFile = process.env.AGY_SYSTEM_PROMPT_FILE;
    if (promptFile && fs.existsSync(promptFile)) {
      const systemPrompt = fs.readFileSync(promptFile, 'utf8');
      const agentDir = path.join(GEMINI_CONFIG_DIR, 'agents', persona);
      fs.mkdirSync(agentDir, { recursive: true });
      const frontmatter = `---\nname: ${persona}\ndescription: GetPod pod assistant\n---\n\n`;
      fs.writeFileSync(path.join(agentDir, 'agent.md'), frontmatter + systemPrompt, { mode: 0o600 });
    }
    const mcpFile = process.env.AGY_MCP_CONFIG_FILE;
    if (mcpFile && fs.existsSync(mcpFile)) {
      fs.mkdirSync(GEMINI_CONFIG_DIR, { recursive: true });
      fs.copyFileSync(mcpFile, path.join(GEMINI_CONFIG_DIR, 'mcp_config.json'));
    }
  } catch (err) {
    process.stderr.write(`agy-shell: config install failed: ${String(err)}\n`);
  }
}

/** Run one agy turn, translating its stream-json onto our stdout. */
function runTurn(text: string, state: AgyTurnState): Promise<void> {
  return new Promise((resolve) => {
    const bin = process.env.AGY_BIN || 'agy';
    const model = agyModelId(process.env.AGY_MODEL || '');
    const persona = process.env.AGY_PERSONA || 'getpod';
    const args = [
      '-p', text,
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      '--agent', persona,
    ];
    if (model) args.push('--model', model);
    if (state.conversationId) args.push('--conversation', state.conversationId);

    state.partialText = '';
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const rl = readline.createInterface({ input: child.stdout });
    let sawResult = false;

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let evt: any;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        return;
      }
      const res = translateAgyEvent(evt, state);
      for (const out of res.lines) process.stdout.write(out + '\n');
      if (res.done) sawResult = true;
    });

    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('error', (err) => {
      process.stdout.write(claudeResultLine(`agy spawn error: ${String(err)}`, true, 0) + '\n');
      resolve();
    });
    child.on('close', () => {
      // If agy exited without a result event, synthesize a terminal error so the
      // gateway never hangs waiting for end-of-turn.
      if (!sawResult) {
        const text = state.partialText || 'agy produced no result';
        process.stdout.write(claudeResultLine(text, true, 0) + '\n');
      }
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const persona = process.env.AGY_PERSONA || 'getpod';
  installAgyConfig(persona);
  const state: AgyTurnState = { conversationId: null, partialText: '' };

  const rl = readline.createInterface({ input: process.stdin });
  const queue: string[] = [];
  let running = false;

  const pump = async () => {
    if (running) return;
    running = true;
    while (queue.length > 0) {
      const text = queue.shift()!;
      await runTurn(text, state);
    }
    running = false;
  };

  rl.on('line', (line) => {
    const text = textFromUserTurn(line.trim());
    if (text !== null) {
      queue.push(text);
      void pump();
    }
  });
  rl.on('close', () => process.exit(0));
}

// Only run the IO loop when invoked directly (not when imported by tests).
if (require.main === module) {
  void main();
}
