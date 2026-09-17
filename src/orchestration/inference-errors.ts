const providerCodes: Readonly<Record<string, string>> = {
  insufficient_quota: 'quota', quota_exceeded: 'quota', billing_error: 'quota', payment_required: 'quota',
  insufficient_credits: 'quota', insufficient_balance: 'quota', credit_balance: 'quota',
  rate_limit: 'rate_limit', rate_limit_error: 'rate_limit', rate_limit_exceeded: 'rate_limit', too_many_requests: 'rate_limit',
  authentication_error: 'authentication', invalid_api_key: 'authentication', unauthenticated: 'authentication',
  overloaded_error: 'capacity', service_unavailable: 'unavailable',
};
const codeCategory = (code: string): string | undefined => Object.prototype.hasOwnProperty.call(providerCodes, code) ? providerCodes[code] : undefined;

function retryGuidance(message: string): string | undefined {
  // Validate the entire clause: never truncate an offset, AM/PM, or compound duration.
  const reset = message.match(/\b(resets?|resetting|retry(?:ing)?|try again)\s+(?:(in|after|at)\s+)?([^\n.!?]{1,160})(?:[\n.!?]|$)/i);
  if (!reset) return undefined;
  const value = reset[3].trim(), connector = reset[2]?.toLowerCase();
  const duration = /^(?:\d{1,4}\s*(?:seconds?|minutes?|hours?|days?))(?:\s*(?:,\s*|and\s+)?\d{1,4}\s*(?:seconds?|minutes?|hours?|days?)){0,3}$/i.test(value);
  const clock = value.match(/^([01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:\s+(AM|PM))?(?:\s+(UTC|GMT)(?:([+-])((?:0?\d|1[0-4]))(?::([0-5]\d))?)?)?$/i);
  if (clock?.[2] && (Number(clock[1]) < 1 || Number(clock[1]) > 12)) return undefined;
  if (clock?.[5] && Number(clock[5]) === 14 && Number(clock[6] ?? 0) !== 0) return undefined;
  if (duration && connector === 'at') return undefined;
  if (!duration && (!clock || ((connector === 'in' || connector === 'after') && (clock[2] || clock[3])))) return undefined;
  const when = duration || connector === 'in' || connector === 'after' ? 'in' : 'at';
  return ` Try again ${/^reset/i.test(reset[1]) ? 'after the limit resets ' : ''}${when} ${value}.`;
}

/** User-facing provider failures, without credentials or internal stack traces. */
export function inferenceFailureMessage(error: unknown): string | undefined {
  const failure = error as { code?: string; message?: string; providerCodes?: string[] } | null;
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
  const base = category === 'quota' ? 'Provider quota or billing limit reached.'
    : category === 'rate_limit' ? 'Provider rate limit reached.'
    : category === 'quota_or_rate_limit' ? 'Provider rate limit or quota reached.'
    : category === 'authentication' ? 'Provider authentication failed.'
    : category === 'capacity' ? '503: Provider capacity is fully in use right now.'
    : 'The model provider is temporarily unavailable.';
  if (category === 'authentication') return base + ' Check your provider credentials.';
  return base + (retryGuidance(detail) ?? (category === 'quota' ? ' Check your provider usage or billing before retrying.'
    : category === 'quota_or_rate_limit' ? ' Check provider usage before retrying.' : ' Please try again later.'));
}
