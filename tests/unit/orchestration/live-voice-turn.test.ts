import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { SessionStore } from '../../../src/session/store';
import { HistoryDB } from '../../../src/history/db';
import type { SessionProcess } from '../../../src/session/process';
import type { AgentConfig, GatewayConfig } from '../../../src/types';

const voice = { enabled: true, stt: { provider: 'elevenlabs', model: 'scribe_v2_realtime' }, tts: { provider: 'elevenlabs', model: 'eleven_v3_conversational', voiceId: 'fixture' },
  notes: { enabled: false } };

/**
 * One live voice turn through the real runtime. The fake agent process answers with
 * the StructuredOutput argument deltas in `deltas`, then the final structured output.
 * `between` runs after each delta, so a test can observe what was spoken mid-turn.
 */
export async function liveVoiceTurn(deltas: string[], final: Record<string, unknown>, options: { voice?: Record<string, unknown>; prompt?: (text: string) => void; between?: (index: number, seen: { marks: string[]; spoken: string[] }) => void | Promise<void> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'live-voice-turn-')), dir = join(root, 'a'), workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true }); writeFileSync(join(workspace, 'CLAUDE.md'), 'Identity');
  const agent = { id: 'a', description: 'fixture', env: '', workspace, claude: { model: 'fixture', extraFlags: [] },
    orchestration: { enabled: true }, voice: { ...voice, ...options.voice } } as unknown as AgentConfig;
  const gateway = { gateway: { orchestration: true, headless: true }, agents: [agent] } as GatewayConfig;
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a'), sid = randomUUID();
  await sessions.ensureApiSession('a', 'web-client', sid);
  let process!: EventEmitter; let prompted!: () => void; const prompt = new Promise<void>(resolve => { prompted = resolve; });
  const runtime = await AgentOrchestrationRuntime.open(agent, gateway, dir, sessions, history, {
    createAgentSession: async (_id, profile) => {
      process = Object.assign(new EventEmitter(), { runtimeProfile: profile, start: async () => {}, interrupt: () => {}, stop: async () => {}, sendMessage: (text: string) => { options.prompt?.(text); prompted(); } });
      return process as SessionProcess;
    }, releaseAgentSession: async () => {},
  });
  const marks: string[] = [], spoken: string[] = [];
  try {
    const accepted = runtime.submitInput({ scope: { agentId: 'a', agentSessionId: sid, source: 'api', accountId: 'owner', chatId: 'web-client', threadKey: '', principalId: 'owner' },
      text: 'What is the price?', modality: 'live_voice', ingressKey: `utterance:${randomUUID()}` }, { execute: false, writeMemory: false }, undefined, phase => marks.push(phase));
    const reading = (async () => { for await (const chunk of accepted.stream!) spoken.push(chunk.text); })();
    await prompt;
    const emit = (event: unknown) => process.emit('output', JSON.stringify(event));
    emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'out', name: 'StructuredOutput' } } });
    for (const [index, partial_json] of deltas.entries()) {
      emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } } });
      await new Promise(resolve => setImmediate(resolve));
      await options.between?.(index, { marks, spoken });
    }
    emit({ type: 'result', structured_output: final });
    const display = await accepted.response;
    await reading;
    return { marks, spoken, display };
  } finally { await runtime.close(); rmSync(root, { recursive: true, force: true }); }
}

test('a live voice turn reports its agent phases: process ready, provider ready, first token and first spoken words', async () => {
  const final = { spoken_text: 'Bitcoin is about sixty-seven thousand dollars.', display_text: '**Bitcoin** is about $67,240.' };
  const json = JSON.stringify(final);
  const { marks, display } = await liveVoiceTurn([json.slice(0, 5), json.slice(5, 30), json.slice(30)], final);
  expect(display).toBe(final.display_text);
  expect(marks).toEqual(['process_spawned', 'first_model_token', 'agent_provider_ready', 'first_spoken_delta']);
});
