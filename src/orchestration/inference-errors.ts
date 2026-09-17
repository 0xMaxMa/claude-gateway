/** User-facing provider failures, without credentials or internal stack traces. */
export function inferenceFailureMessage(error: unknown): string | undefined {
  const failure = error as { code?: string; message?: string } | null;
  if (failure?.code === 'PROVIDER_CAPACITY') return '503: Provider capacity is fully in use right now. Please try again later.';
  if (failure?.code === 'PROVIDER_UNAVAILABLE') return '503: The model provider is temporarily unavailable. Please try again shortly.';
  if (failure?.code !== 'INFERENCE_FAILED' || typeof failure.message !== 'string') return undefined;
  const detail = failure.message.slice(0, 4096);
  const quota = /\b(?:daily|monthly|weekly|credit|usage|spending|billing|payment|quota)\b.{0,50}\b(?:limit|exhausted|reached|exceeded|required|failed)\b|\b(?:insufficient_quota|billing_error|payment_required|credit_balance|HTTP\s*402)\b/i.test(detail);
  const rateLimit = /\b(?:rate[ _-]?limit(?:ed|_exceeded)?|too many requests|HTTP\s*429|API Error:\s*429)\b/i.test(detail);
  const auth = /\b(?:authentication[ _](?:failed|error)|invalid[ _]api[ _]key|invalid x-api-key|unauthorized|invalid credentials|HTTP\s*401|API Error:\s*401)\b/i.test(detail);
  const unavailable = /\b(?:service unavailable|provider unavailable|temporarily unavailable|HTTP\s*503|API Error:\s*503)\b/i.test(detail);
  if (!quota && !rateLimit && !auth && !unavailable) return undefined;
  const base = quota ? 'Provider quota or billing limit reached.'
    : rateLimit ? 'Provider rate limit reached.'
    : auth ? 'Provider authentication failed.'
    : 'The model provider is temporarily unavailable.';
  // Extract only a short time expression; arbitrary provider text may include secrets.
  const reset = detail.match(/\b(resets?|resetting|retry(?:ing)?|try again)\s+(?:(in|after|at)\s+)?(\d{1,4}\s*(?:seconds?|minutes?|hours?|days?)\b|(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:\s*(?:UTC|GMT)\b)?)(?![\d:])/i);
  const when = reset && (reset[2]?.toLowerCase() === 'at' || (!reset[2] && reset[3].includes(':'))) ? 'at' : 'in';
  const guidance = reset ? ` Try again ${/^reset/i.test(reset[1]) ? 'after the limit resets ' : ''}${when} ${reset[3].trim()}.`
    : quota ? ' Check your provider usage or billing before retrying.'
    : auth ? ' Check your provider credentials.' : ' Please try again later.';
  return base + guidance;
}
