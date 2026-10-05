import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { OrchestrationError } from './types';
import { TaskFiles } from './task-files';
import { VoiceError } from '../voice/types';
import { splitNarration, isSpeakable } from '../voice/narrate-split';
import { ttsProvider } from '../voice/providers/registry';
import { resolveVoiceId } from '../voice/providers/voice-catalog';
import type { AgentVoiceConfig } from './config';

export type NarrateConfig = Required<NonNullable<AgentVoiceConfig['narrate']>>;
export interface NarrateTts { provider: string; model: string; voiceId: string; }
export interface NarrateDeps {
  files: TaskFiles;
  config: () => NarrateConfig;
  /** Voice settings of the chat the task belongs to (per-chat voice choice wins). */
  settings: (conversation: { source: string; chat_id: string; thread_key: string }) => NarrateTts;
  provider?: typeof ttsProvider;
  voice?: typeof resolveVoiceId;
  /** Concatenate mp3 files in order into `output`; defaults to ffmpeg. */
  merge?: (inputs: string[], output: string, signal: AbortSignal) => Promise<void>;
  ffmpegAvailable?: () => Promise<boolean>;
}
export interface NarrateResult {
  ok: boolean; parts_total: number; parts_staged: number; files: number; chars: number;
  stopped_reason?: string; error?: string;
}

const MAX_FILES = 10;
const MAX_TTS_CHARS = 4000;
const run = promisify(execFile);

async function ffmpegAvailable(): Promise<boolean> {
  try { await run('ffmpeg', ['-version'], { timeout: 5000 }); return true; } catch { return false; }
}
async function ffmpegMerge(inputs: string[], output: string, signal: AbortSignal): Promise<void> {
  const list = `${output}.txt`;
  writeFileSync(list, inputs.map(file => `file '${file.replace(/'/g, `'\\''`)}'`).join('\n'), { mode: 0o600 });
  try {
    await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', output],
      { timeout: 60000, signal, maxBuffer: 65536 });
  } finally { rmSync(list, { force: true }); }
}

/** Adjacent parts per output file so that at most MAX_FILES files are produced. */
export function narrationGroups(parts: number): number[][] {
  const files = Math.min(parts, MAX_FILES), groups: number[][] = [];
  let next = 0;
  for (let file = 0; file < files; file++) {
    const size = Math.floor(parts / files) + (file < parts % files ? 1 : 0);
    groups.push(Array.from({ length: size }, () => next++));
  }
  return groups;
}

/** Read the text to narrate. Content is untrusted data and is never echoed in errors. */
function source(deps: NarrateDeps, attemptId: string, generation: number, args: Record<string, unknown>, maxChars: number): string {
  const keys = Object.keys(args);
  if (keys.some(key => !['text', 'path'].includes(key)) || (args.text === undefined) === (args.path === undefined))
    throw new OrchestrationError('NARRATE_ARGS_INVALID', 'NARRATE_ARGS_INVALID: pass exactly one of text or path.');
  if (args.text !== undefined) {
    if (typeof args.text !== 'string') throw new OrchestrationError('NARRATE_ARGS_INVALID', 'NARRATE_ARGS_INVALID: text must be a string.');
    return args.text;
  }
  let path: string;
  try { path = deps.files.allowedPath(attemptId, generation, args.path); }
  catch (error) {
    if (error instanceof OrchestrationError && error.code === 'STALE_ATTEMPT') throw error;
    throw new OrchestrationError('NARRATE_PATH_DENIED', 'NARRATE_PATH_DENIED: path is missing, not a regular file, or outside this task scope.');
  }
  const info = statSync(path);
  if (!info.isFile()) throw new OrchestrationError('NARRATE_PATH_DENIED', 'NARRATE_PATH_DENIED: path is not a regular file.');
  if (info.size > maxChars * 4) throw new OrchestrationError('NARRATE_FILE_TOO_LARGE', `NARRATE_FILE_TOO_LARGE: file is ${info.size} bytes; limit is ${maxChars * 4} (voice.narrate.maxChars=${maxChars}).`);
  return readFileSync(path, 'utf8');
}

/** Gateway side of the `narrate` worker tool: split, synthesize piece by piece, stage in order. */
export function workerNarrate(deps: NarrateDeps) {
  const merge = deps.merge ?? ffmpegMerge, hasFfmpeg = deps.ffmpegAvailable ?? ffmpegAvailable;
  return async (attemptId: string, generation: number, actionId: string, args: Record<string, unknown>, signal: AbortSignal): Promise<NarrateResult> => {
    const config = deps.config();
    const { conversation, mediaDir } = deps.files.scope(attemptId, generation);
    if (!config.enabled) throw new OrchestrationError('NARRATE_DISABLED', 'NARRATE_DISABLED: voice.narrate.enabled is false.');
    const text = source(deps, attemptId, generation, args, config.maxChars);
    if (!isSpeakable(text)) throw new OrchestrationError('NARRATE_EMPTY', 'NARRATE_EMPTY: the text has no speakable characters.');
    if (text.length > config.maxChars) throw new OrchestrationError('NARRATE_TOO_LONG', `NARRATE_TOO_LONG: ${text.length} characters exceeds voice.narrate.maxChars=${config.maxChars}.`);
    // Symbol-only pieces cannot be synthesized; fold them into a neighbour so the text stays intact.
    const pieces: string[] = [];
    let carry = '';
    for (const piece of splitNarration(text, Math.min(config.targetChars, MAX_TTS_CHARS))) {
      if (isSpeakable(piece.text)) { pieces.push(carry + piece.text); carry = ''; }
      else if (pieces.length) pieces[pieces.length - 1] += piece.text;
      else carry += piece.text;
    }
    if (pieces.length > config.maxParts) throw new OrchestrationError('NARRATE_TOO_LONG', `NARRATE_TOO_LONG: ${pieces.length} parts exceeds voice.narrate.maxParts=${config.maxParts}.`);
    const groups = narrationGroups(pieces.length);
    if (groups.some(group => group.length > 1) && !await hasFfmpeg())
      throw new OrchestrationError('NARRATE_FFMPEG_MISSING', `NARRATE_FFMPEG_MISSING: ${pieces.length} parts need merging into at most ${MAX_FILES} files and ffmpeg is not installed.`);

    const settings = deps.settings(conversation as { source: string; chat_id: string; thread_key: string });
    if (!settings.provider) throw new OrchestrationError('NARRATE_TTS_NOT_CONFIGURED', 'NARRATE_TTS_NOT_CONFIGURED: no TTS provider is configured (voice.tts.provider).');
    const tts = (deps.provider ?? ttsProvider)(settings);
    if (!tts.synthesizeFile) throw new OrchestrationError('NARRATE_TTS_UNSUPPORTED', 'NARRATE_TTS_UNSUPPORTED: the configured TTS provider cannot produce audio files.');
    const voiceId = await (deps.voice ?? resolveVoiceId)(settings);
    const work = join(mediaDir, `narrate-${randomUUID()}`);
    mkdirSync(work, { recursive: true, mode: 0o700 });
    const done: string[] = [];
    let stopped: string | undefined;
    try {
      for (const [index, piece] of pieces.entries()) {
        if (signal.aborted) { stopped = 'NARRATE_CANCELLED'; break; }
        try {
          const audio = await tts.synthesizeFile({ text: piece, voiceId, signal: AbortSignal.any([signal, AbortSignal.timeout(config.partTimeoutMs)]) });
          if (!audio.bytes.length) throw new VoiceError('TTS_INCOMPLETE');
          const file = join(work, `part-${String(index + 1).padStart(3, '0')}.mp3`);
          writeFileSync(file, audio.bytes, { mode: 0o600 });
          done.push(file);
        } catch (error) {
          stopped = signal.aborted ? 'NARRATE_CANCELLED'
            : error instanceof VoiceError && error.code === 'MANAGED_VOICE_QUOTA_EXHAUSTED' ? 'NARRATE_QUOTA_EXHAUSTED'
            : `NARRATE_TTS_FAILED:${error instanceof VoiceError ? error.code : (error as Error)?.name === 'TimeoutError' ? 'TTS_TIMEOUT' : 'TTS_SYNTHESIS_FAILED'}`;
          break;
        }
      }
      // A cancelled task never completes, so its audio would not be delivered anyway.
      if (stopped === 'NARRATE_CANCELLED') throw new OrchestrationError('NARRATE_CANCELLED', `NARRATE_CANCELLED: stopped after ${done.length} of ${pieces.length} parts.`);
      let staged = 0;
      for (const [fileIndex, group] of groups.entries()) {
        const parts = group.filter(index => index < done.length).map(index => done[index]);
        if (!parts.length) break;
        const name = join(work, `narration-${String(fileIndex + 1).padStart(2, '0')}-of-${String(groups.length).padStart(2, '0')}.mp3`);
        if (parts.length === 1) { writeFileSync(name, readFileSync(parts[0]), { mode: 0o600 }); }
        else {
          try { await merge(parts, name, signal); }
          catch (error) {
            if (signal.aborted) throw new OrchestrationError('NARRATE_CANCELLED', `NARRATE_CANCELLED: stopped while merging ${parts.length} parts.`);
            throw new OrchestrationError('NARRATE_MERGE_FAILED', `NARRATE_MERGE_FAILED: ffmpeg could not merge ${parts.length} parts (${(error as NodeJS.ErrnoException).code ?? 'exit'}).`);
          }
        }
        deps.files.stage(attemptId, generation, `${actionId}:narrate:${fileIndex}`, { path: name });
        staged += parts.length;
      }
      const result: NarrateResult = { ok: !stopped, parts_total: pieces.length, parts_staged: staged, files: groups.filter(g => g[0] < done.length).length, chars: text.length };
      if (stopped) { result.stopped_reason = stopped; result.error = stopped; }
      return result;
    } finally { rmSync(work, { recursive: true, force: true }); }
  };
}
