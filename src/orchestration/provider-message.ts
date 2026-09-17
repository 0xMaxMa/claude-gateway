/** Display provider text without interpreting its language, reset syntax or wording. */
export function sanitizeProviderMessage(text: string): string | undefined {
  const safe = text
    .replace(/\b(?:Bearer|Basic)\s+[^\s"'<>]+/gi, '[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\b(?:set-cookie|cookie)\s*:\s*[^\r\n]+/gi, '[redacted cookie]')
    .replace(/(["']?[a-z0-9_-]*(?:api[_-]?key|token|password|secret|authorization|cookie)["']?\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[redacted]')
    .replace(/https?:\/\/[^\s<>"']+/gi, value => {
      try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); }
      catch { return '[redacted URL]'; }
    })
    .split('\n').filter(line => !/^\s*at\s+/.test(line)).join('\n')
    .replace(/(^|[\s("'])(?:[A-Za-z]:\\|\/)(?:[^\s"'<>:]+[\\/])+[^\s"'<>:]*/g, '$1[redacted path]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
  return safe ? safe.slice(0, 4096) : undefined;
}

/** Only typed error envelopes supply provider display text, never ordinary replies. */
export function structuredProviderMessage(value: unknown, depth = 0, budget = { nodes: 256 }, errorEnvelope = false): string | undefined {
  if (depth >= 8 || --budget.nodes < 0 || !value) return undefined;
  if (typeof value === 'string') return /^API Error:\s*\d{3}\b/.test(value) ? value : undefined;
  if (typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 32)) {
      const message = structuredProviderMessage(item, depth + 1, budget, errorEnvelope);
      if (message) return message;
    }
    return undefined;
  }
  const entry = value as Record<string, unknown>;
  if (entry.error && typeof entry.error === 'object') {
    const nested = structuredProviderMessage(entry.error, depth + 1, budget, true);
    if (nested) return nested;
  }
  if ((errorEnvelope || typeof entry.type === 'string' || typeof entry.code === 'string' || typeof entry.status === 'number') && typeof entry.message === 'string') {
    return entry.message;
  }
  return undefined;
}
