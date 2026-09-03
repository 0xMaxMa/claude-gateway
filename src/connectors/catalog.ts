/**
 * Hardcoded connector catalog.
 *
 * Empty by default. This tier is for a deployer's OWN hand-reviewed, hardcoded
 * connectors whose auth kind is already supported (none / secret) — add an
 * entry here and token-env, resolve, the router and the web panel are all
 * generic enough to pick it up with no other changes.
 *
 * GetPod's own offerings (github/gmail/google-drive/google-calendar) are
 * deliberately NOT here — they're pushed in as managed custom connectors by
 * services/api instead (see connectors-router.ts's POST /oauth/receive and
 * services/api's internal/vm/connector_push.go). Keeping GetPod's own product
 * decisions (which endpoint, which scopes) out of this file matters because
 * this repo is a fork meant to be PR'd back upstream — baking product opinion
 * into shared fork code would make every future endpoint/scope change touch a
 * file we also want to keep diff-minimal for that PR.
 */

import type { ConnectorSpec } from './types';

export const CONNECTOR_CATALOG: ConnectorSpec[] = [];

export function getConnectorSpec(id: string): ConnectorSpec | undefined {
  return CONNECTOR_CATALOG.find((c) => c.id === id);
}
