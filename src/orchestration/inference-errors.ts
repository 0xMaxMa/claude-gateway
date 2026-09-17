import { sanitizeProviderMessage } from './provider-message';
const providerCodes: Readonly<Record<string, string>> = {
  insufficient_quota: 'quota', quota_exceeded: 'quota', billing_error: 'quota', payment_required: 'quota',
  insufficient_credits: 'quota', insufficient_balance: 'quota', credit_balance: 'quota',
  rate_limit: 'rate_limit', rate_limit_error: 'rate_limit', rate_limit_exceeded: 'rate_limit', too_many_requests: 'rate_limit',
  authentication_error: 'authentication', invalid_api_key: 'authentication', unauthenticated: 'authentication',
  overloaded_error: 'capacity', service_unavailable: 'unavailable',
};
const codeCategory = (code: string): string | undefined => Object.prototype.hasOwnProperty.call(providerCodes, code) ? providerCodes[code] : undefined;

/** User-facing provider failures, without credentials or internal stack traces. */
export function inferenceFailureMessage(error: unknown): string | undefined {
  const failure = error as { code?: string; message?: string; providerCodes?: string[]; providerMessage?: string } | null;
  if (failure?.code === 'WORKSPACE_CONTEXT_MISSING') return 'The agent could not start because its workspace context (CLAUDE.md) is missing. Restore the required workspace files and restart the agent.';
  if (failure && ['INFERENCE_FAILED', 'PROVIDER_CAPACITY', 'PROVIDER_UNAVAILABLE'].includes(failure.code ?? '') && typeof failure.providerMessage === 'string') {
    const message = sanitizeProviderMessage(failure.providerMessage);
    if (message) return message;
  }
  if (failure?.code === 'PROVIDER_CAPACITY') return '503: Provider capacity is fully in use right now. Please try again later.';
  if (failure?.code === 'PROVIDER_UNAVAILABLE') return '503: The model provider is temporarily unavailable. Please try again shortly.';
  if (failure?.code !== 'INFERENCE_FAILED' || typeof failure.message !== 'string') return undefined;
  const detail = failure.message.slice(0, 4096);
  // Prefer error codes from the same CLI events legacy already consumes.
  const explicit = failure.providerCodes?.map(codeCategory).filter(Boolean) ?? [];
  let category = explicit.find(value => value !== 'rate_limit');
  // A generic CLI rate_limit also represents daily credits (#499); prose may refine it.
  if (!category) {
    const textCodes = (detail.toLowerCase().match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []).map(codeCategory);
    const quota = textCodes.includes('quota') || /\b(?:daily|monthly|weekly|credit|usage|spending|billing|payment|quota)\b.{0,50}\b(?:limit|exhausted|reached|exceeded|required|failed)\b|\bcredit balance\b.{0,30}\b(?:too low|insufficient|empty)\b|\b(?:HTTP|API Error:)\s*402\b/i.test(detail);
    category = quota ? 'quota' : explicit[0] ?? textCodes.find(Boolean);
    if (!category && /\b(?:authentication failed|invalid api key|invalid x-api-key|unauthorized|invalid credentials|HTTP\s*401|API Error:\s*401)\b/i.test(detail)) category = 'authentication';
    if (!category && /\b(?:rate[ -]limit(?:ed)?|too many requests)\b/i.test(detail)) category = 'rate_limit';
    if (!category && /\b(?:HTTP\s*429|API Error:\s*429)\b/i.test(detail)) category = 'quota_or_rate_limit';
    if (!category && /\b(?:service unavailable|provider unavailable|temporarily unavailable|HTTP\s*503|API Error:\s*503)\b/i.test(detail)) category = 'unavailable';
  }
  if (!category) return undefined;
  // Older callers carry only an Error message. Once identified as a provider
  // failure, preserve its wording too; do not parse a reset time out of prose.
  if (detail && !failure.providerCodes?.length && !/^HTTP \d{3}$/.test(detail)) return sanitizeProviderMessage(detail);
  const base = category === 'quota' ? 'Provider quota or billing limit reached.'
    : category === 'rate_limit' ? 'Provider rate limit reached.'
    : category === 'quota_or_rate_limit' ? 'Provider rate limit or quota reached.'
    : category === 'authentication' ? 'Provider authentication failed.'
    : category === 'capacity' ? '503: Provider capacity is fully in use right now.'
    : 'The model provider is temporarily unavailable.';
  if (category === 'authentication') return base + ' Check your provider credentials.';
  return base + (category === 'quota' ? ' Check your provider usage or billing before retrying.'
    : category === 'quota_or_rate_limit' ? ' Check provider usage before retrying.' : ' Please try again later.');
}
