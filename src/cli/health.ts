/**
 * The one `/health` probe every CLI command uses.
 *
 * There were three of these — in `doctor`, `gateway status` and `service
 * install` — at three different fidelities, and a bug fixed in one survived in
 * the others (a leaked abort timer needed the same fix three times). One
 * implementation means one behaviour and one place to fix.
 */

export interface HealthProbe {
  /** True only for a 2xx: the CLI can actually use this URL. */
  ok: boolean;
  /** True when something answered at all, whatever the status. */
  answered: boolean;
  /** The HTTP status, when there was one. */
  status?: number;
  /** One line fit to show an operator. */
  detail: string;
}

/**
 * Probe `<baseUrl>/health`.
 *
 * A status is reported verbatim rather than collapsed into "no response": a
 * reverse proxy that replies 401 is *up*, and saying otherwise sends the
 * operator to debug a proxy that is working fine.
 *
 * The abort timer is cleared in `finally`. A rejected fetch would otherwise
 * skip clearTimeout and leave a live timer holding the event loop open — and an
 * unreachable gateway is exactly the case these commands are run for.
 */
export async function probeHealth(baseUrl: string, timeoutMs = 3000): Promise<HealthProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    if (res.ok) return { ok: true, answered: true, status: res.status, detail: 'gateway responding' };
    return {
      ok: false,
      answered: true,
      status: res.status,
      detail: `HTTP ${res.status} (answered, but not a healthy gateway)`,
    };
  } catch (err) {
    const aborted = (err as { name?: string } | undefined)?.name === 'AbortError';
    return {
      ok: false,
      answered: false,
      detail: aborted ? `no response (timed out after ${timeoutMs}ms)` : 'no response',
    };
  } finally {
    clearTimeout(timer);
  }
}
