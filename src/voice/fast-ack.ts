import { agentIdentity } from '../orchestration/jev-gateway';
import { speechVoiceStyle } from '../orchestration/speech';
import { messagesEndpoint, modelAuthHeaders, type ModelConnection } from '../automation/model-choice-evaluator';

/** Thai digits as ASCII, so "623" and "๖๒๓" are the same number. */
const asciiDigits = (text: string) => text.replace(/[๐-๙]/g, digit => String(digit.charCodeAt(0) - 0x0e50));
/** Bounds a spoken acknowledgement. It must say "I heard you" and nothing the answer could
 * contradict, so a reply holding a link, markup, more than one short line, or a number the caller
 * did not say (`heard`) is not spoken at all. */
export function fastAckText(reply: string, heard = ''): string | undefined {
  const text = reply.trim();
  if (!/\p{L}/u.test(text) || text.length > 80 || /[\r\n{}[\]<>|*#`_~]|https?:|www\./i.test(text)) return undefined;
  const said = new Set(asciiDigits(heard).match(/\d+/g) ?? []);
  if ((asciiDigits(text).match(/\d+/g) ?? []).some(number => !said.has(number))) return undefined;
  return text;
}

/** One hesitation or restart word at the start of the text, longest alternative first. Each
 * alternative is tried once per position (no nested repetition), so matching stays linear. */
const FILLER = /^(?:เอาใหม่|เดี๋ยวก่อน|เดี๋ยว|แบบว่า|แบบ|คือว่า|คือ|แป๊บ|นึง|ก่อน|ใหม่|เอ่อ|เอ้อ|เออ|เอ่|เอ้า|อ่า|อ้า|อา|อืม|อือ|อ่ะ|อะ|นะ|holdon|sorry|wait|well|like|huh|oh|so|u+h*m*|e+r+m*|h+m+|m+|a+h+)/u;
/** A transcript that is only hesitation, a restart or too short to be a request: it gets no
 * acknowledgement and costs no model call. Thai STT often joins words without spaces, so the
 * words are peeled off a spacing-free copy. */
export function fillerOnly(transcript: string): boolean {
  let rest = transcript.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
  if (rest.length < 3) return true;
  for (let match = FILLER.exec(rest); rest && match?.[0]; match = FILLER.exec(rest)) rest = rest.slice(match[0].length);
  return !rest;
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
    const text = fastAckText((body?.content ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join(''), [transcript, ...(options.context?.recentTurns ?? [])].join(' '));
    return { ...usage, text, elapsedMs: Date.now() - started, outcome: text ? 'ready' : 'skipped' };
  } catch (error) {
    return { elapsedMs: Date.now() - started, outcome: 'failed', code: options.signal.aborted ? 'CANCELLED' : error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'UNAVAILABLE' };
  }
}
