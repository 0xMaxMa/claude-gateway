/** Both surfaces are generated in one inference; validate them at the CLI boundary. */
export const SPEECH_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    display_text: {type: 'string', minLength: 1},
    spoken_text: {type: 'string', minLength: 1, maxLength: 600},
  },
  required: ['display_text', 'spoken_text'],
};
export const SPEECH_OVERLAY = `For this voice-enabled turn return ONLY one JSON object with exactly two string fields:
{"display_text":"complete answer for chat, including all useful detail", "spoken_text":"brief natural spoken answer"}.
First understand the user's intent and conversation context. For greetings, casual conversation or a question you can answer directly, answer naturally; do not announce work or give a generic acknowledgement.
Language: an explicit requested response language takes precedence over the language of the user's message, prior conversation, identity defaults and TTS voice style. Unless the user explicitly requests different languages for chat and audio, write spoken_text in the same language as display_text. For example, a Thai request to introduce yourself in Japanese (jp) requires both the introduction in chat and the spoken introduction in Japanese, not a Thai summary. Preserve this requested language in spoken_acknowledgement and subsequent Worker result notifications for that request. Voice selection controls vocal identity, never translation or response language.
Use the same task-ownership perspective in display_text, spoken_text and spoken_acknowledgement: describe your own work in the existing persona's voice. Routine speech must not announce delegation to a worker. Remain factual about queued versus running tasks, results and failures.
When actual work is needed, include spoken_acknowledgement in your first task_spawn call: a brief natural sentence in the user's language describing the specific action you will take and any relevant detail from their request. The gateway handles acknowledgement playback; live web voice can play immediately and channel voice follows its text receipt. Do not say work has already finished or pretend it has already started. Never use the same stock receipt for unrelated requests.
Your final display_text for this delegation turn should agree with that contextual reply. The gateway deduplicates acknowledgement playback; do not add a second acknowledgement or say that it has already been heard.
After spawning a worker, end this turn with a brief factual progress update. Do not poll or wait for that worker to finish; a separate automatic notification turn will report its persisted result.
On an automatic task notification, report the actual result or failure without starting more work.
Compose both in this same turn. spoken_text normally contains 1–3 short sentences, at most 600 characters.
For reviews/reports speak the conclusion, most important issue and next step; retain all findings and evidence in display_text.
Do not read code, diffs, tables, URLs or raw tool receipts aloud. For follow-up questions answer the specific point using existing task results, without re-running work unnecessarily.
If the user explicitly requests a longer oral explanation, explain the requested part within 600 characters and offer to continue.
Never claim a task finished before its persisted result. Both fields must agree on facts and uncertainty. Do not infer that TTS is unavailable from earlier conversation complaints: the gateway handles playback. Speak the requested answer itself rather than announcing that you wrote it in chat or speculating about playback status.`;
export function splitSpeechResponse(raw: string): { display: string; spoken: string } {
  const normalized = raw.trim().replace(/^```(?:json)?\s*\n/, '').replace(/\n```$/, '');
  // Some CLI turns prepend a progress sentence to their final JSON. Accept
  // only a complete trailing object with explicit speech fields; never infer
  // speech from that prefix, a partial object, or arbitrary report prose.
  const starts = [...normalized.matchAll(/\{(?=\s*"(?:display_text|spoken_text)"\s*:)/g)].slice(-32).map(match => match.index!);
  for (const candidate of [normalized, ...starts.map(index => normalized.slice(index))]) {
    try {
      const value = JSON.parse(candidate);
      if (typeof value.display_text === 'string' && value.display_text.trim() ) {
        const spoken = typeof value.spoken_text === 'string' ? value.spoken_text.trim() : '';
        // Fail closed for malformed/over-budget speech, rather than reading the full report.
        return { display: value.display_text, spoken: spoken.length <= 600 && !/```/.test(spoken) ? spoken : '' };
      }
    } catch { /* Try the final explicit object, then keep the text-only fallback. */ }
  }
  // A short conversational answer is already suitable speech. Preserve its
  // language and wording; never truncate reports or read code/URLs/JSON aloud.
  const plain = raw.trim().replace(/\*\*([^*]+)\*\*/g, '$1');
  const spoken = plain && plain.length <= 600 && !/[{}\[\]`|]|https?:\/\/|^\s*#/m.test(plain) ? plain : '';
  return { display: raw, spoken };
}


export function speechVoiceStyle(gender?: string): string {
  if (gender !== 'female' && gender !== 'male') return '';
  return '\nTTS voice style (selected by the user, not the user\'s gender): Apply the following Thai forms ONLY when the response language is Thai. For any other language, use natural expression in that language without Thai particles or translation. Never switch the requested response language to satisfy voice style. ' +
    (gender === 'female'
      ? 'Use feminine Thai self-expression in spoken_text and spoken_acknowledgement: ค่ะ for statements/answers, คะ for questions and นะคะ where natural. For your own first-person voice omit the pronoun or use ฉัน, not ผม; do not end your own sentences with ครับ.'
      : 'Use masculine Thai self-expression in spoken_text and spoken_acknowledgement: ครับ and ผม where natural; do not end your own sentences with คะ/ค่ะ.') +
    ' Compose these forms grammatically in context, not by global string replacement. Preserve quoted words, names, facts, and the user’s identity. This speech style does not require changing display_text. Apply it to immediate acknowledgements, ordinary replies and completed Worker results.';
}
