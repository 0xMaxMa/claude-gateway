import { SPOKEN_TEXT_LIMIT } from './response-schema';
import { fenceAdjusted } from './display-stream';

/** Both surfaces are generated in one inference. The field contract itself lives in the
 * invariant ORCHESTRATION_RESPONSE_SCHEMA declared on every turn; this overlay is the
 * per-turn text (below the cache breakpoint) that tells the model to fill spoken_text. */
export const SPEECH_OVERLAY = `For this voice-enabled turn return ONLY one JSON object with exactly two string fields:
{"display_text":"complete answer for chat, including all useful detail", "spoken_text":"brief natural spoken answer"}.
First understand the user's intent and conversation context. For greetings, casual conversation or a question you can answer directly, answer naturally; do not announce work or give a generic acknowledgement.
Language: an explicit requested response language takes precedence over the language of the user's message, prior conversation, identity defaults and TTS voice style. Unless the user explicitly requests different languages for chat and audio, write spoken_text in the same language as display_text. For example, a Thai request to introduce yourself in Japanese (jp) requires both the introduction in chat and the spoken introduction in Japanese, not a Thai summary. Preserve this requested language in spoken_acknowledgement and subsequent Worker result notifications for that request. Voice selection controls vocal identity, never translation or response language.
Use the same task-ownership perspective in display_text, spoken_text and spoken_acknowledgement: describe your own work in the existing persona's voice. Use natural first-person progress sentences about completed work and the current verified action, not an observer's narration or labels like 'What is happening now:'. Routine speech must not announce delegation to a worker, forwarding advice, or waiting for a worker report. Distinguish a planned next step from an action already underway; only state the latter when supported by evidence. Remain factual about queued versus running tasks, results and failures.
When actual work is needed, include spoken_acknowledgement in your first task_spawn call: a brief natural sentence in the user's language describing the specific action you will take and any relevant detail from their request. The gateway handles acknowledgement playback; live web voice can play immediately and channel voice follows its text receipt. Do not say work has already finished or pretend it has already started. Never use the same stock receipt for unrelated requests.
Your final display_text for this delegation turn should agree with that contextual reply. The gateway deduplicates acknowledgement playback; do not add a second acknowledgement or say that it has already been heard.
After spawning a worker, end this turn with a brief factual progress update. Do not poll or wait for that worker to finish; a separate automatic notification turn will report its persisted result.
On an automatic task notification, report the actual result or failure without starting more work.
Compose both in this same turn. spoken_text normally contains 1–3 short sentences, at most 600 characters.
For reviews/reports speak the conclusion, most important issue and next step; retain all findings and evidence in display_text.
Do not read code, diffs, tables, URLs or raw tool receipts aloud. For follow-up questions answer the specific point using existing task results, without re-running work unnecessarily.
If the user explicitly requests a longer oral explanation, explain the requested part within 600 characters and offer to continue.
Never claim a task finished before its persisted result. Both fields must agree on facts and uncertainty. Do not infer that TTS is unavailable from earlier conversation complaints: the gateway handles playback. Speak the requested answer itself rather than announcing that you wrote it in chat or speculating about playback status.`;
/** How the raw turn text resolved into the user-facing surfaces.
 * 'structured'  — display_text was read out of the declared union payload.
 * 'plain'       — no payload at all; the prose IS the reply and nothing was lost.
 * 'empty_display' — a payload parsed but carried no usable display_text.
 * 'unreadable'  — the turn emitted a payload that could not be parsed (truncated/invalid).
 * The last two are degradations on EVERY turn kind, not just speech ones: the reply the
 * model composed is gone, so the caller must record them rather than let them pass. */
export type ResponseTextOutcome = 'structured' | 'plain' | 'empty_display' | 'unreadable';

/** Shown only when a payload displaced the entire reply and left no prose behind. Raw JSON
 * must never be published, and an empty chat bubble reads as the agent ignoring the user. */
export const UNREADABLE_DISPLAY_NOTICE = 'I could not produce a readable reply for that turn. Please ask again.';

/** Index just past the object opened at `start`, or -1 when it never closes. */
function objectEnd(text: string, start: number): number {
  let depth = 0, inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

/** A turn that was trying to EMIT a payload puts the object on its own line and ends there,
 * at most followed by one short sign-off sentence. A reply that explains the format writes it
 * into a sentence, or keeps writing after it, and must be published exactly as written. */
const TRAILING_SIGN_OFF_LIMIT = 120;

/** The span of the turn text that is an attempt to emit the declared payload, if any.
 * `body` is the JSON to parse and [start,end) is everything to remove when it turns out to
 * be unusable — the object plus the fence that wraps it. Prose before it is tolerated on its
 * own lines (CLI turns prepend progress sentences); anything that reads like an answer which
 * merely quotes the format is left alone, because unwrapping one would publish the example
 * in place of the answer and stripping one would edit the answer. */
function payloadSpan(text: string): { body: string; start: number; end: number } | undefined {
  const matches = [...text.matchAll(/\{(?=\s*"(?:display_text|spoken_text|notify_user)"\s*:)/g)];
  // Only the last object can qualify: anything earlier has even more text after it.
  const opening = matches[matches.length - 1]?.index;
  if (opening === undefined) {
    // An object truncated inside its very first key never matches the pattern above.
    return /^\{\s*"?[a-z_]*$/.test(text) ? { body: text, start: 0, end: text.length } : undefined;
  }
  const start = fenceAdjusted(text, opening);
  const closed = objectEnd(text, opening);
  // An object that never closes ended the turn: the model was cut off mid-payload, which no
  // finished sentence quoting an example ever looks like.
  if (closed < 0) return { body: text.slice(opening), start, end: text.length };
  // An object written into a sentence is an example inside an answer, and a message holding
  // one is explaining the format — so none of its objects are this turn's payload.
  if (matches.some(match => !/(?:^|\n)[ \t]*$/.test(text.slice(0, fenceAdjusted(text, match.index!))))) return undefined;
  const end = closed + (/^[ \t]*\r?\n?[ \t]*```/.exec(text.slice(closed))?.[0].length ?? 0);
  return text.slice(end).trim().length <= TRAILING_SIGN_OFF_LIMIT
    ? { body: text.slice(opening, closed), start, end } : undefined;
}

export function splitSpeechResponse(raw: string): { display: string; spoken: string; outcome: ResponseTextOutcome } {
  const text = raw.trim();
  // A short conversational answer is already suitable speech. Preserve its language and
  // wording; never truncate reports or read code/URLs/JSON aloud. Applied to whatever text
  // we are about to display, so a stripped payload cannot be spoken either.
  const speakable = (source: string): string => {
    const plain = source.replace(/\*\*([^*]+)\*\*/g, '$1');
    return plain && plain.length <= SPOKEN_TEXT_LIMIT && !/[{}\[\]`|]|https?:\/\/|^\s*#/m.test(plain) ? plain : '';
  };
  const payload = payloadSpan(text);
  if (!payload) return { display: raw, spoken: speakable(text), outcome: 'plain' };
  let value: unknown;
  try { value = JSON.parse(payload.body); } catch { /* Truncated or invalid; degrade below. */ }
  const fields = (value && typeof value === 'object' ? value : {}) as { display_text?: unknown; spoken_text?: unknown };
  if (typeof fields.display_text === 'string' && fields.display_text.trim()) {
    const spoken = typeof fields.spoken_text === 'string' ? fields.spoken_text.trim() : '';
    // Fail closed for malformed/over-budget speech, rather than reading the full report.
    return { display: fields.display_text, spoken: spoken.length <= SPOKEN_TEXT_LIMIT && !/```/.test(spoken) ? spoken : '', outcome: 'structured' };
  }
  // No usable display_text. Publishing `raw` here is what used to put the JSON object itself
  // into the user's chat, so publish the prose around it instead, and an explicit notice when
  // the payload was the whole turn. The outcome is returned rather than swallowed: the union
  // schema is declared on every turn, so reaching here means the model did not honour it. See
  // runtime.ts's response.schema_unstructured event, which records it for every turn kind.
  const remainder = `${text.slice(0, payload.start)}\n${text.slice(payload.end)}`;
  const display = /[\p{L}\p{N}]/u.test(remainder) ? remainder.trim() : UNREADABLE_DISPLAY_NOTICE;
  return { display, spoken: speakable(display), outcome: value ? 'empty_display' : 'unreadable' };
}


export function speechVoiceStyle(gender?: string): string {
  if (gender !== 'female' && gender !== 'male') return '';
  return '\nTTS voice style (selected by the user, not the user\'s gender): Apply the following Thai forms ONLY when the response language is Thai. For any other language, use natural expression in that language without Thai particles or translation. Never switch the requested response language to satisfy voice style. ' +
    (gender === 'female'
      ? 'Use feminine Thai self-expression in spoken_text and spoken_acknowledgement: ค่ะ for statements/answers, คะ for questions and นะคะ where natural. For your own first-person voice omit the pronoun or use ฉัน, not ผม; do not end your own sentences with ครับ.'
      : 'Use masculine Thai self-expression in spoken_text and spoken_acknowledgement: ครับ and ผม where natural; do not end your own sentences with คะ/ค่ะ.') +
    ' Compose these forms grammatically in context, not by global string replacement. Preserve quoted words, names, facts, and the user’s identity. This speech style does not require changing display_text. Apply it to immediate acknowledgements, ordinary replies and completed Worker results.';
}
