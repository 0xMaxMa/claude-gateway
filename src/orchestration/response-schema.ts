/** The one response contract declared on EVERY agent decision turn.
 *
 * Anthropic's prompt cache is a strict prefix match over [tools, system, messages].
 * src/session/runtime-profile.ts turns RuntimeProfile.responseSchema into the CLI's
 * --json-schema flag, and that flag appends a synthetic StructuredOutput tool to the
 * tools block. Verified against the installed claude-code 2.1.274 binary: the flag only
 * (a) appends the tool to the request's tool array and (b) injects one bounded turn-end
 * "call the StructuredOutput tool now" nudge when the turn ended without it. It does NOT
 * set tool_choice — the main query loop always sends toolChoice: undefined — so declaring
 * the schema does not force an ordinary reply through a JSON tool call, and the model may
 * still answer in plain text (both parsers below keep tolerating that).
 *
 * Because the tool renders at position 0 of the cached prefix, a schema attached on only
 * SOME turns of a session invalidates tools+system+messages every time the session switches
 * mode. Anthropic's prescribed remedy is an invariant tool set with the mode carried in
 * message content — not removing the tool. So this schema is the union of every turn shape
 * and is attached unconditionally; the per-turn overlay text (SPEECH_OVERLAY,
 * PROGRESS_REVIEW_OVERLAY, INTAKE_OVERLAY — all appended to the prompt, below the cache
 * breakpoint) remains the mechanism that says which optional fields this turn must fill.
 *
 * Only display_text is required, so an ordinary text turn satisfies the union with exactly
 * the one field it already produced; nothing about a normal turn's user-facing output
 * changes. Length limits are deliberately absent: structured outputs does not enforce
 * minLength/maxLength server-side, so the spoken-length budget is enforced in our own code
 * (splitSpeechResponse/progressReviewResult) instead of being decorative schema text.
 *
 * Frozen so the single canonical definition also has a single canonical serialization:
 * runtimeProfileArgs JSON.stringify()s this exact object on every turn, and byte-identical
 * CLI args are the whole point.
 */
export const SPOKEN_TEXT_LIMIT = 600;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export const ORCHESTRATION_RESPONSE_SCHEMA: Record<string, unknown> = deepFreeze({
  type: 'object',
  additionalProperties: false,
  description: 'Your reply for this turn. Always fill display_text. Fill the optional fields only when this turn\'s instructions explicitly ask for them.',
  properties: {
    display_text: {
      type: 'string',
      description: 'The complete reply shown to the user in chat, in the user\'s language. On an ordinary turn this is your entire answer: write exactly what you would have written as a plain reply, with the same detail, structure and formatting. Never summarise it or move content elsewhere.',
    },
    spoken_text: {
      type: 'string',
      description: `Only when this turn's instructions ask for speech: a brief natural spoken version of display_text, at most ${SPOKEN_TEXT_LIMIT} characters, in the same language. Omit this field entirely on an ordinary text turn.`,
    },
    notify_user: {
      type: 'boolean',
      description: 'Only on an internal progress-review turn, where the instructions define it: whether the user should receive this update. Omit this field entirely on every other turn.',
    },
  },
  required: ['display_text'],
});
