// ElevenLabs v3/v4 audio tags. Only the ElevenLabs dialogue models and Gemini 3.1 Flash TTS perform
// them; any other TTS model would read the word aloud, so known tags are stripped for those models.
// A bracket followed by `(` is markdown link text, not a tag.
const AUDIO_TAG = /[ \t]*\[(?:laughs?|laughing|chuckles|giggles|sighs?|whispers?|gasps?|sarcastic|excited|curious|crying|happy|sad|angry|surprised|nervous|exhales|inhales|clears throat|pause|short pause|long pause)\](?!\()[ \t]*/gi;
// Longest known tag plus slack; a longer unclosed bracket is not a tag split across chunks.
const MAX_TAG_LENGTH = 24;
// Keep a word break between two words, but none before punctuation or inside unspaced text.
const joinAroundTag = (tag: string, offset: number, text: string): string => {
  const before = text[offset - 1], after = text[offset + tag.length];
  return before && after && /^\s|\s$/.test(tag) && !/[\s.,!?;:)\]}]/.test(after) ? ' ' : '';
};

export const stripAudioTags = (text: string): string => text.replace(AUDIO_TAG, joinAroundTag);

/** Where text that is still arriving can be cut: before a trailing tag (open, or closed with nothing
 * after it yet to decide the join or a link) and before trailing spaces a tag may absorb. */
function settledLength(text: string): number {
  const open = text.lastIndexOf('[');
  const close = open < 0 ? -1 : text.indexOf(']', open);
  let cut = text.length;
  if (open >= 0 && (close < 0 ? text.length - open <= MAX_TAG_LENGTH : !text.slice(close + 1).trim())) cut = open;
  while (cut > 0 && /[ \t]/.test(text[cut - 1])) cut--;
  return cut;
}

/** The part of a partial chat text that can be shown without tags. Each longer prefix of the
 * same text extends the previous result, so a stream of it never has to take text back. */
export const audioTagFreePrefix = (text: string): string => stripAudioTags(text.slice(0, settledLength(text)));

/** Streaming form: holds back a trailing tag until the text after it shows how to join it. */
export function withoutAudioTags(text: AsyncIterable<string>): AsyncIterable<string> {
  const source = text[Symbol.asyncIterator]();
  let closed = false;
  const stripped = strippedChunks({ [Symbol.asyncIterator]: () => source }, () => closed);
  // An async generator queues return() behind a pending next(), so a stalled source would never
  // hear it. Forward it directly, as the TTS providers' teardown expects, and stop reading.
  return { [Symbol.asyncIterator]: () => ({
    next: () => stripped.next(),
    return: async () => { closed = true; await source.return?.(); return { done: true as const, value: undefined }; },
  }) };
}
async function* strippedChunks(text: AsyncIterable<string>, closed: () => boolean): AsyncGenerator<string> {
  let pending = '', previous = '';
  // The last character already sent decides whether a tag at the start of this text sat between words.
  const strip = (segment: string) => stripAudioTags(previous + segment).slice(previous.length);
  for await (const chunk of text) {
    if (closed()) return;
    pending += chunk;
    const cut = settledLength(pending);
    const ready = strip(pending.slice(0, cut));
    if (!ready) continue;
    pending = pending.slice(cut);
    previous = /\S/.test(ready.slice(-1)) ? ready.slice(-1) : '';
    yield ready;
  }
  const rest = strip(pending);
  if (rest.trim()) yield rest;
}
