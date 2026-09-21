import type { CodexContextMeasurement } from '../session/codex-context';
/** Shared by server report and browser drawer; only validated numbers reach HTML. */
export function codexContextHtml(value?: CodexContextMeasurement): string {
  if (!value) return '';
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  const count = (n: unknown): string => !valid(n) ? '—' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1000 ? (n / 1000).toFixed(2) + 'K' : String(n);
  const percent = valid(value.used) && valid(value.observed) && value.observed > 0 ? ' · ' + (value.used / value.observed * 100).toFixed(1) + '%' : '';
  const source = value.limitSource === 'documented-model' ? 'documented model ceiling' : 'provider ceiling unverified';
  const note = valid(value.observed) && valid(value.requested) && value.observed < value.requested ? 'Native usable context is below the request; native catalog limits and reserved headroom apply.' : 'Native measurement is not a certification of upstream capacity.';
  return '<section class="detail-block"><h3>Worker context window</h3><div>Native context: ' + count(value.used) + ' / ' + count(value.observed) + percent + '</div><div>Requested: ' + count(value.requested) + ' · Configured: ' + count(value.configured) + '</div><div>Provider ceiling: ' + count(value.providerLimit) + ' · ' + source + '</div><p class="muted">' + note + '</p></section>';
}
