/**
 * Hardcoded connector catalog.
 *
 * Empty by default. This tier is for a deployer's OWN hand-reviewed, hardcoded
 * connectors whose auth kind is already supported (none / secret) — add an
 * entry here and token-env, resolve, the router and the web panel are all
 * generic enough to pick it up with no other changes.
 *
 * Managed OAuth connectors (Google Workspace, GitHub, or anything else an
 * external control plane owns the client_secret for) are deliberately NOT
 * here — they're pushed in as managed custom connectors instead (see
 * connectors-router.ts's POST /oauth/receive). Keeping that kind of
 * product-specific decision (which endpoint, which scopes) out of this file
 * keeps the built-in catalog generic, free of any one deployer's own product
 * opinions.
 */

import type { ConnectorSpec } from './types';

export const CONNECTOR_CATALOG: ConnectorSpec[] = [];

export function getConnectorSpec(id: string): ConnectorSpec | undefined {
  return CONNECTOR_CATALOG.find((c) => c.id === id);
}
