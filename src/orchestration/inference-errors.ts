/** User-facing provider failures, without credentials or internal stack traces. */
export function inferenceFailureMessage(error: unknown): string | undefined {
  const failure = error as { code?: string; message?: string } | null;
  if (failure?.code === 'PROVIDER_CAPACITY') return '503: Provider capacity is fully in use right now. Please try again later.';
  if (failure?.code === 'PROVIDER_UNAVAILABLE') return '503: The model provider is temporarily unavailable. Please try again shortly.';
  if (failure?.code === 'INFERENCE_FAILED' && typeof failure.message === 'string' && /^API Error:/i.test(failure.message)) {
    return failure.message.replace(/^API Error:\s*/i, '').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]').replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 1000);
  }
  return undefined;
}
