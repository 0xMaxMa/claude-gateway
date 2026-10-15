// ElevenLabs v3/v4 audio tags. Only the ElevenLabs dialogue models and Gemini TTS perform them;
// any other TTS model would read the word aloud, so known tags are stripped for those models.
const AUDIO_TAG = /[ \t]*\[(?:laughs?|laughing|chuckles|giggles|sighs?|whispers?|gasps?|sarcastic|excited|curious|crying|happy|sad|angry|surprised|nervous|exhales|inhales|clears throat|pause|short pause|long pause)\][ \t]*/gi;
// Longest known tag plus slack; a longer unclosed bracket is not a tag split across chunks.
const MAX_TAG_LENGTH = 24;
// Keep a word break between two words, but none before punctuation or inside unspaced text.
const joinAroundTag = (tag: string, offset: number, text: string): string => {
  const before = text[offset - 1], after = text[offset + tag.length];
  return before && after && /^\s|\s$/.test(tag) && !/[\s.,!?;:)\]}]/.test(after) ? ' ' : '';
};

export const stripAudioTags = (text: string): string => text.replace(AUDIO_TAG, joinAroundTag);

/** Streaming form: holds back a trailing tag until the text after it shows how to join it. */
export function withoutAudioTags(text: AsyncIterable<string>): AsyncIterable<string> {
  const source = text[Symbol.asyncIterator]();
  const stripped = strippedChunks({ [Symbol.asyncIterator]: () => source });
  // An async generator queues return() behind a pending next(), so a stalled source would never
  // hear it. Forward it directly, as the TTS providers' teardown expects.
  return { [Symbol.asyncIterator]: () => ({
    next: () => stripped.next(),
    return: async () => { await source.return?.(); return { done: true as const, value: undefined }; },
  }) };
}
async function* strippedChunks(text: AsyncIterable<string>): AsyncGenerator<string> {
  let pending = '', previous = '';
  // The last character already sent decides whether a tag at the start of this text sat between words.
  const strip = (segment: string) => stripAudioTags(previous + segment).slice(previous.length);
  for await (const chunk of text) {
    pending += chunk;
    const open = pending.lastIndexOf('[');
    const close = open < 0 ? -1 : pending.indexOf(']', open);
    let cut = pending.length;
    if (open >= 0 && (close < 0 ? pending.length - open <= MAX_TAG_LENGTH : !pending.slice(close + 1).trim())) {
      cut = open;
      while (cut > 0 && /[ \t]/.test(pending[cut - 1])) cut--;
    }
    const ready = strip(pending.slice(0, cut));
    if (!ready) continue;
    pending = pending.slice(cut);
    previous = /\S/.test(ready.slice(-1)) ? ready.slice(-1) : '';
    yield ready;
  }
  const rest = strip(pending);
  if (rest.trim()) yield rest;
}
