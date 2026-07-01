/**
 * Pure, dependency-free helpers for the LINE channel — unit-tested in isolation
 * (mirrors mcp/tools/telegram/pure.ts and mcp/tools/discord/outbound.ts chunkText).
 */

/** LINE hard limit: max characters in a single text message object. */
export const LINE_TEXT_LIMIT = 5000;
/** LINE hard limit: max message objects per push/reply request. */
export const LINE_MAX_MESSAGES_PER_REQUEST = 5;

/**
 * Split text into chunks each <= limit chars. Prefers to break on a newline
 * within the limit; falls back to a hard cut. Always returns at least one chunk
 * (an empty string in → [''], so callers always have something to send).
 */
export function chunkText(text: string, limit = LINE_TEXT_LIMIT): string[] {
  if (limit <= 0) return [text];
  if (text.length === 0) return [''];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < 0) cut = limit; // not found — hard cut
    else if (cut === 0) { rest = rest.slice(1); continue; } // leading newline — skip, retry
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length > 0) out.push(rest);
  return out.length > 0 ? out : [''];
}

/** Group items into batches of <= size (default = LINE per-request message cap). */
export function batch<T>(items: T[], size = LINE_MAX_MESSAGES_PER_REQUEST): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface LineSendPlan {
  /** First batch (<=5 objects) to send via the FREE reply API, or null when no usable reply token. */
  replyBatch: string[] | null;
  /** Remaining batches to send via the metered push API. */
  pushBatches: string[][];
}

/**
 * Decide how to deliver chunked text given whether a usable reply token exists.
 *
 * Reply-token-first to save push quota: LINE counts push/broadcast against the OA
 * monthly message quota but **reply-token messages are free**. The single-use token
 * can carry one reply call of up to LINE_MAX_MESSAGES_PER_REQUEST objects, so it
 * takes the FIRST batch; anything beyond one batch must push. With no token,
 * everything pushes. The runtime falls back to push if the reply call fails (token
 * expired/invalid/already used) — that fallback lives in module.ts, not here.
 */
export function planLineSend(chunks: string[], hasReplyToken: boolean): LineSendPlan {
  const batches = batch(chunks);
  if (!hasReplyToken || batches.length === 0) {
    return { replyBatch: null, pushBatches: batches };
  }
  return { replyBatch: batches[0], pushBatches: batches.slice(1) };
}
