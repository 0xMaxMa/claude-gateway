/** Read-only, allowlisted dashboard projection. Never return scope/account IDs. */
export function dashboardProviderWait(value: unknown): {
  state: 'waiting_for_provider'; reason: string; nextRetryAt?: number; requiresConfigurationChange: boolean;
} | undefined {
  let parsed: any;
  try { parsed = typeof value === 'string' ? JSON.parse(value) : value; } catch { return; }
  if (!parsed || parsed.state !== 'waiting_for_provider') return;
  const reasons = ['first_response_timeout', 'transport', 'server', 'rate_limit', 'quota', 'authentication', 'configuration'];
  return { state: 'waiting_for_provider', reason: reasons.includes(parsed.reason) ? parsed.reason : 'unknown',
    ...(Number.isSafeInteger(parsed.nextRetryAt) && parsed.nextRetryAt > 0 && parsed.nextRetryAt <= 8640000000000000 ? { nextRetryAt: parsed.nextRetryAt } : {}),
    requiresConfigurationChange: parsed.requiresConfigurationChange === true };
}

export function readDashboardProviderWait(
  get: (sql: string, ...params: any[]) => Record<string, any> | undefined,
  hasTable: boolean, entityId: string, state?: string,
): ReturnType<typeof dashboardProviderWait> {
  if (!hasTable || state !== undefined && state !== 'queued') return;
  return dashboardProviderWait(get('SELECT waiting_json FROM provider_waits WHERE entity_id=?', entityId)?.waiting_json);
}
