import { VoiceError } from './types';

type Category = 'payment' | 'authentication' | 'permission' | 'quota' | 'daily_quota' | 'rate_limit' | 'unavailable' | 'language' | 'model' | 'timeout' | 'network' | 'cancelled' | 'invalid_response' | 'invalid_request' | 'unknown';
const descriptions: Record<Category, [string, boolean]> = {
  payment: ['The voice provider requires payment. Check provider credits or billing before trying again.', false],
  authentication: ['No API key is configured or the voice provider rejected it. Check the connected API key.', false],
  permission: ['The voice provider denied access. Check API key permissions and model access.', false],
  daily_quota: ['The voice provider daily quota is exhausted. Wait for the quota to reset or check provider billing before trying again.', false],
  quota: ['The voice provider quota is exhausted. Check provider usage or billing before trying again.', false],
  rate_limit: ['The voice provider is receiving too many requests. Wait before trying again.', true],
  unavailable: ['The voice provider is temporarily unavailable. Please try again later.', true],
  language: ['The selected voice model does not support this language. Choose another language or model.', false],
  model: ['The selected model or voice is unavailable. Check the voice settings and provider access.', false],
  timeout: ['The voice provider did not respond in time. Please try again.', true],
  network: ['Could not connect to the voice provider. Check the connection and try again.', true],
  cancelled: ['The voice request was cancelled.', false],
  invalid_response: ['The voice provider returned incomplete or invalid audio or transcription. Please try again.', true],
  invalid_request: ['The voice provider rejected the request. Check the selected model, language and voice settings.', false],
  unknown: ['The voice request failed without a recognized diagnostic. Use the reference ID when reporting this problem.', false],
};
// Explicit provider codes only. Never infer causes from free-form messages.
const providerCodes: Record<string, Category> = {
  insufficient_credits: 'payment', insufficient_balance: 'payment', payment_required: 'payment',
  quota_exceeded: 'quota', insufficient_quota: 'quota',
  rate_limit_exceeded: 'rate_limit', too_many_requests: 'rate_limit', too_many_concurrent_requests: 'rate_limit',
  invalid_api_key: 'authentication', unauthenticated: 'authentication', permission_denied: 'permission',
  unsupported_language: 'language', language_not_supported: 'language',
  model_not_found: 'model', voice_not_found: 'model', model_not_supported: 'model',
};
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}
export function providerVoiceError(prefix: 'STT' | 'TTS' | 'VOICE', status?: number, payload?: unknown): VoiceError {
  const body = object(payload), error = object(body.error), detail = object(body.detail);
  const candidates = [error.code, error.status, detail.code, detail.status, body.code, body.err_code, body.status, body.error, body.detail];
  const dailyQuota = status === 429 && Array.isArray(error.details) && error.details.some(value => {
    const quota = object(value);
    return quota['@type'] === 'type.googleapis.com/google.rpc.QuotaFailure' && Array.isArray(quota.violations) && quota.violations.some(value => {
      const violation = object(value);
      return typeof violation.quotaId === 'string' && /(?:Requests|Tokens)PerDay(?:Per|$|-)/.test(violation.quotaId);
    });
  });
  const category = dailyQuota ? 'daily_quota' : candidates.map(v => typeof v === 'string' && Object.prototype.hasOwnProperty.call(providerCodes, v.toLowerCase()) ? providerCodes[v.toLowerCase()] : undefined).find(Boolean);
  return new VoiceError(`${prefix}_PROVIDER_ERROR${status ? `_HTTP_${status}` : ''}${category ? `_REASON_${category.toUpperCase()}` : ''}`);
}
/** Limit error-body reads; no raw provider body is retained or returned to clients. */
export async function providerHttpError(prefix: 'STT' | 'TTS' | 'VOICE', response: Response): Promise<VoiceError> {
  let payload: unknown;
  const reader = response.body?.getReader();
  if (reader) {
    const timer = setTimeout(() => { void reader.cancel().catch(() => {}); }, 2000);
    try {
      const parts: Uint8Array[] = []; let size = 0;
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.length; if (size > 16384) break;
        parts.push(chunk.value);
      }
      if (size <= 16384) payload = JSON.parse(Buffer.concat(parts).toString('utf8'));
    } catch { /* Preserve status even if the body is not JSON. */ }
    finally { clearTimeout(timer); await reader.cancel().catch(() => {}); }
  }
  return providerVoiceError(prefix, response.status, payload);
}
export function describeVoiceError(error: unknown) {
  const code = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const httpStatus = Number(code.match(/_HTTP_(\d{3})/)?.[1]) || undefined;
  const explicit = code.match(/_REASON_([A-Z_]+)$/)?.[1]?.toLowerCase() as Category | undefined;
  let category: Category = explicit && Object.prototype.hasOwnProperty.call(descriptions, explicit) ? explicit : 'unknown';
  if (category === 'unknown') {
    if (httpStatus === 402) category = 'payment';
    else if (httpStatus === 401 || /CREDENTIALS_MISSING/.test(code)) category = 'authentication';
    else if (httpStatus === 403) category = 'permission';
    // A bare 429 cannot reliably distinguish an exhausted quota from a rate limit.
    else if (httpStatus === 429) return { category: 'quota_or_rate_limit', message: 'The voice provider rate limit or quota was reached (HTTP 429). Check provider usage before retrying.', retryable: false, httpStatus };
    else if (httpStatus === 408 || httpStatus === 504 || /TIMEOUT|TimeoutError/.test(code)) category = 'timeout';
    else if (httpStatus && httpStatus >= 500) category = 'unavailable';
    else if (/LANGUAGE_UNSUPPORTED|UNSUPPORTED_LANGUAGE/.test(code)) category = 'language';
    else if (/INVALID_VOICE_MODEL|UNKNOWN_TTS_PROVIDER|UNKNOWN_STT_PROVIDER|TTS_FILE_UNSUPPORTED/.test(code)) category = 'model';
    else if (httpStatus && httpStatus >= 400) category = 'invalid_request';
    else if (/PROVIDER_CONNECTION|PROVIDER_SEND|fetch failed|ECONN|ENOTFOUND/.test(code)) category = 'network';
    else if (/PROVIDER_ABORTED|AbortError/.test(code)) category = 'cancelled';
    else if (/INVALID_SPEECH_AUDIO|INCOMPLETE|INVALID_RESPONSE|INVALID_PROVIDER_MESSAGE|DECODE|UNSUPPORTED_AUDIO_FORMAT|No audio/.test(code)) category = 'invalid_response';
  }
  const [message, retryable] = descriptions[category];
  return { category, message: message + (httpStatus ? ` (HTTP ${httpStatus})` : ''), retryable, ...(httpStatus ? { httpStatus } : {}) };
}

export async function voiceProviderRequest(url: URL | string, init: RequestInit, request: typeof fetch = fetch): Promise<Response> {
  try { return await request(url, init); }
  catch (error) {
    const reason = init.signal?.reason;
    if (reason?.name === 'TimeoutError' || (error instanceof Error && error.name === 'TimeoutError')) throw new VoiceError('PROVIDER_TIMEOUT');
    if (init.signal?.aborted) throw new VoiceError('PROVIDER_ABORTED');
    throw new VoiceError('PROVIDER_CONNECTION_FAILED');
  }
}
