import { agentIdentity } from '../orchestration/jev-gateway';
import { messagesEndpoint, modelAuthHeaders, type ModelConnection } from '../automation/model-choice-evaluator';

/** Bounds a spoken acknowledgement. It must say "I heard you" and nothing the answer could
 * contradict, so a reply holding a number, a link, markup or more than one short line is not
 * spoken at all. */
export function fastAckText(reply: string): string | undefined {
  const text = reply.trim();
  if (!/\p{L}/u.test(text) || text.length > 80 || /[\r\n0-9๐-๙{}[\]<>|*#`_~]|https?:|www\./i.test(text)) return undefined;
  return text;
}

const SYSTEM = 'You voice a short acknowledgement in a live phone call while the assistant prepares its real answer. '
  + 'Reply with ONE short spoken phrase (at most 8 words) in the caller\'s language saying you heard them and are on it. '
  + 'Never answer, never state a fact, number, name, result or opinion, never promise an outcome, never ask a question. '
  + 'If the caller is only greeting, thanking, saying goodbye or making small talk, or no acknowledgement fits, reply with exactly "-". '
  + 'Output only the phrase.';
/** The voice's Thai particles, as the main reply uses them for this voice (speechVoiceStyle). */
const STYLE: Record<string, string> = {
  female: ' The voice is female: in Thai end with ค่ะ or นะคะ, never ครับ.',
  male: ' The voice is male: in Thai end with ครับ, never ค่ะ or คะ.',
};

export interface FastAckResult { text?: string; inputTokens?: number; outputTokens?: number; elapsedMs: number; outcome: 'ready' | 'skipped' | 'failed'; code?: string }

/**
 * One cheap model call for a spoken acknowledgement of the caller's words. It uses the same
 * endpoint and credential as the agent's own Claude CLI (agentIdentity), so no new secret is
 * involved. Nothing it returns is stored: it is not part of the conversation history or memory.
 */
export async function fastAcknowledgement(transcript: string, options: { model: string; timeoutMs: number; gender?: string; signal: AbortSignal;
  connection?: () => ModelConnection; fetch?: typeof fetch }): Promise<FastAckResult> {
  const started = Date.now();
  try {
    const connection = (options.connection ?? agentIdentity)();
    const endpoint = messagesEndpoint(connection.baseUrl);
    const response = await (options.fetch ?? fetch)(endpoint, { method: 'POST', redirect: 'error',
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]),
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...modelAuthHeaders(connection, endpoint) },
      body: JSON.stringify({ model: options.model, max_tokens: 60, thinking: { type: 'disabled' },
        system: SYSTEM + (STYLE[options.gender ?? ''] ?? ''), messages: [{ role: 'user', content: transcript.slice(0, 2000) }] }) });
    const body = await response.json().catch(() => undefined) as { content?: Array<{ type?: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } } | undefined;
    const usage = { inputTokens: body?.usage?.input_tokens, outputTokens: body?.usage?.output_tokens };
    if (!response.ok) return { ...usage, elapsedMs: Date.now() - started, outcome: 'failed', code: `HTTP_${response.status}` };
    const text = fastAckText((body?.content ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join(''));
    return { ...usage, text, elapsedMs: Date.now() - started, outcome: text ? 'ready' : 'skipped' };
  } catch (error) {
    return { elapsedMs: Date.now() - started, outcome: 'failed', code: options.signal.aborted ? 'CANCELLED' : error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'UNAVAILABLE' };
  }
}
