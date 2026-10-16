import { SPOKEN_TEXT_LIMIT } from './response-schema';

/** A sentence end (with any closing quote or bracket) followed by space, a line break, or a
 * space between two Thai characters: Thai writes no full stops and separates phrases and
 * sentences with a space, while a space next to Latin text or a number is inside a sentence. */
const BOUNDARY = /[.!?…。！？]+["'”’)\]]*\s+|\n\s*|(?<=[฀-๿])\s+(?=[฀-๿])/g;

/**
 * Split the spoken text that has arrived so far into pieces TTS can speak now. A piece ends
 * at a boundary once it holds at least `minChars`, so speech does not stutter in fragments;
 * text that runs past `maxChars` without one is cut at its last space (or hard at the limit)
 * so a long unbroken run cannot hold the voice back. `consumed` is how much of `text` the
 * pieces cover; the rest waits for more text, or is the last piece when `final`.
 */
export function spokenPieces(text: string, final: boolean, minChars = 24, maxChars = 160): { pieces: string[]; consumed: number } {
  const pieces: string[] = [];
  let start = 0;
  const take = (end: number) => { const piece = text.slice(start, end).trim(); if (piece) pieces.push(piece); start = end; };
  for (const match of text.matchAll(BOUNDARY)) {
    if (match.index! < start) continue;
    if (text.slice(start, match.index).trim().length >= minChars) take(match.index! + match[0].length);
  }
  while (!final && text.length - start > maxChars) {
    const window = text.slice(start, start + maxChars), space = window.search(/\s\S*$/);
    take(start + (space > minChars ? space + 1 : maxChars));
  }
  if (final) take(text.length);
  return { pieces, consumed: start };
}

/**
 * The spoken_text of one live voice turn, handed to TTS piece by piece while the agent is
 * still writing its response. It reads only spoken_text, never display_text. Speech that the
 * final response check would reject (over SPOKEN_TEXT_LIMIT, or holding a code fence) stops
 * streaming at once. `finish` returns only what the final spoken_text adds after the pieces
 * already spoken, so nothing is said twice.
 */
export class SpokenTextStream {
  private streamed = '';
  private stopped = false;
  constructor(private readonly speak: (text: string) => void) {}
  update(text: string, complete: boolean): void {
    if (this.stopped) return;
    if (text.length > SPOKEN_TEXT_LIMIT || text.includes('```')) { this.stopped = true; return; }
    const { pieces, consumed } = spokenPieces(text.slice(this.streamed.length), complete);
    this.streamed = text.slice(0, this.streamed.length + consumed);
    for (const piece of pieces) this.speak(piece);
  }
  finish(spoken: string): string {
    const said = this.streamed.trim();
    if (!said) return spoken;
    return spoken.startsWith(said) ? spoken.slice(said.length).trim() : '';
  }
}
