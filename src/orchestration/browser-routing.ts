import { resolveEnabledConnectors } from '../connectors/resolve';
import type { AgentConfig, GatewayConfig } from '../types';

/** Return only connector IDs, never resolved URLs/headers/credentials. */
export function remoteBrowserIds(entries: Record<string, { sourceUrl?: string }>, enabled: Record<string, unknown>): string[] {
  return Object.keys(enabled).filter(id => id === 'getpod-remote-browser' ||
    /^https:\/\/github\.com\/Crown-Labs\/getpod-remote-browser\/?$/i.test(entries[id]?.sourceUrl ?? ''));
}
export function browserRouting(agent: AgentConfig, gateway: GatewayConfig, hostConnectors = true): string {
  const entries = gateway.gateway.customConnectors ?? {};
  const ids = agent.type === 'app-agent' || !hostConnectors || agent.allow_tools === false ? [] :
    remoteBrowserIds(entries, resolveEnabledConnectors(agent, entries, gateway.gateway.connectorsDefaultEnabled ?? true));
  return `Browser environment selection (takes precedence over older browser skill instructions):
Cloud Browser = gateway browser_* MCP tools, running in GetPod's cloud environment. It is NOT the user's Chrome and does not share the user's tabs, cookies or login sessions.
Remote Browser = the connected Remote Browser MCP, controlling only user-approved tabs on their device.
Connected and enabled Remote Browser connector IDs for this agent: ${JSON.stringify(ids)}. Connected means configured/paired, not proof the device is online or access approved.
${ids.length ? 'For a generic "open browser/open website" request with no previously selected environment, ask a short choice BEFORE dispatch: "Use Remote Browser on your device (recommended), or GetPod Cloud Browser?" Recommend Remote Browser because it is connected, but do not guess the target. Once the user selects, reuse that choice for related follow-up work without asking each step.' : 'With no enabled Remote Browser connector, generic browser/website requests use Cloud Browser normally. Explicit requests for the user device or Remote Browser must instead report that a Remote Browser connector is needed; do not silently use Cloud Browser.'}
Explicit "remote browser", "my Chrome", "my computer", or the user device selects Remote Browser; explicit "cloud browser" or "GetPod browser" selects Cloud Browser. Preserve an explicit choice over defaults. Include the selected environment in the task instructions and keep the whole browser workflow in one task. Workers must respect that choice, discover the corresponding MCP tools, and never replace Remote Browser with gateway browser_* just because an old skill says ALWAYS use it. If a worker receives an ambiguous task while Remote Browser is connected, use task_request_input before any browser mutation. If the selected environment is unavailable, offline, denied or fails, report that blocker and request permission before switching environments. Never replay a failed remote action on Cloud Browser automatically. The open-browser skill is Cloud Browser only.`;
}
