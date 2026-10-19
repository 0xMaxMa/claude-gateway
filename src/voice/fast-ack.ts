import { agentIdentity } from '../orchestration/jev-gateway';
import { speechVoiceStyle } from '../orchestration/speech';
import { messagesEndpoint, modelAuthHeaders, type ModelConnection } from '../automation/model-choice-evaluator';

/** Bounds a spoken acknowledgement. It must say "I heard you" and nothing the answer could
 * contradict, so a reply holding a link, markup, more than one short line, or a number the caller
 * did not say (`heard`) is not spoken at all. */
export function fastAckText(reply: string, heard = ''): string | undefined {
  const text = reply.trim();
  if (!/\p{L}/u.test(text) || text.length > 80 || /[\r\n{}[\]<>|*#`_~]|https?:|www\./i.test(text)) return undefined;
  const said = new Set(heard.match(/[0-9๐-๙]+/g) ?? []);
  if ((text.match(/[0-9๐-๙]+/g) ?? []).some(number => !said.has(number))) return undefined;
  return text;
}

/** Hesitation and restart words that carry no request on their own. Thai STT often joins words
 * without spaces, so a transcript is filler when it is any run of these with spacing removed. */
const FILLER = /^(?:เอ่อ|เออ|เอ้อ|เอ่|อ่า|อ้า|อา|อืม|อือ|อ่ะ|อะ|เอ้า|เอาใหม่|ใหม่|เดี๋ยว|ก่อน|แป๊บ|นึง|แบบว่า|แบบ|คือว่า|คือ|นะ|um+|uh+|uhm+|er+|erm+|hm+|mm+|ah+|oh|huh|wait|holdon|sorry|so|well|like)+$/u;
/** A transcript that is only hesitation, a restart or too short to be a request: it gets no
 * acknowledgement and costs no model call. */
export function fillerOnly(transcript: string): boolean {
  const letters = transcript.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
  return FILLER.test(letters) || (letters.match(/\p{L}/gu) ?? []).length < 3;
}

const SYSTEM = 'You voice a short acknowledgement in a live phone call while the assistant prepares its real answer. '
  + 'Reply with ONE short spoken phrase (at most 8 words) in the caller\'s language that names the specific thing they just asked for, so they know they were understood '
  + '(for example "เดี๋ยวเปิด PR 623 ดูให้นะคะ" or "Let me look up that invoice"). '
  + 'Never answer, never state a fact, number, name, result or opinion the caller did not say, never promise an outcome, never ask a question. '
  + 'Never repeat or paraphrase an acknowledgement already spoken in this call, and never use a generic phrase that would fit any request. '
  + 'Reply with exactly "-" when the caller is only greeting, thanking, saying goodbye or making small talk, when their words are unclear, unfinished or only hesitation, '
  + 'or when no specific acknowledgement fits. When in doubt reply "-". Output only the phrase.';

/** What the call has said so far: the caller's previous turns and the acknowledgements already spoken. */
export interface FastAckContext { recentTurns: string[]; recentAcks: string[] }
function ackPrompt(transcript: string, context?: FastAckContext): string {
  const list = (items: string[] = []) => items.map(item => `- ${item.slice(0, 500)}`).join('\n');
  const sections = [
    context?.recentTurns.length ? `Earlier caller turns (context only):\n${list(context.recentTurns)}` : '',
    context?.recentAcks.length ? `Acknowledgements already spoken in this call (do not repeat or paraphrase):\n${list(context.recentAcks)}` : '',
  ].filter(Boolean);
  return sections.length ? `${sections.join('\n\n')}\n\nCaller's latest words:\n${transcript.slice(0, 2000)}` : transcript.slice(0, 2000);
}

export interface FastAckResult { text?: string; inputTokens?: number; outputTokens?: number; elapsedMs: number; outcome: 'ready' | 'skipped' | 'failed'; code?: string }

/**
 * One cheap model call for a spoken acknowledgement of the caller's words. It uses the same
 * endpoint and credential as the agent's own Claude CLI (agentIdentity), so no new secret is
 * involved. Nothing it returns is stored: it is not part of the conversation history or memory.
 */
export async function fastAcknowledgement(transcript: string, options: { model: string; timeoutMs: number; gender?: string; signal: AbortSignal; context?: FastAckContext;
  connection?: () => ModelConnection; fetch?: typeof fetch }): Promise<FastAckResult> {
  const started = Date.now();
  try {
    const connection = (options.connection ?? agentIdentity)();
    const endpoint = messagesEndpoint(connection.baseUrl);
    const response = await (options.fetch ?? fetch)(endpoint, { method: 'POST', redirect: 'error',
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]),
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...modelAuthHeaders(connection, endpoint) },
      body: JSON.stringify({ model: options.model, max_tokens: 60, thinking: { type: 'disabled' },
        system: SYSTEM + speechVoiceStyle(options.gender), messages: [{ role: 'user', content: ackPrompt(transcript, options.context) }] }) });
    const body = await response.json().catch(() => undefined) as { content?: Array<{ type?: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } } | undefined;
    const usage = { inputTokens: body?.usage?.input_tokens, outputTokens: body?.usage?.output_tokens };
    if (!response.ok) return { ...usage, elapsedMs: Date.now() - started, outcome: 'failed', code: `HTTP_${response.status}` };
    const text = fastAckText((body?.content ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join(''), transcript);
    return { ...usage, text, elapsedMs: Date.now() - started, outcome: text ? 'ready' : 'skipped' };
  } catch (error) {
    return { elapsedMs: Date.now() - started, outcome: 'failed', code: options.signal.aborted ? 'CANCELLED' : error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'UNAVAILABLE' };
  }
}
