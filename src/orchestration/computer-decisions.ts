import type { AgentConfig, GatewayConfig } from '../types';
import type { ComputerUseDependencies } from '../automation/computer-use';
import type { ThinkingConfig } from '../../lib/automation/thinking.cjs';
import type { BrowserTextHelperConfig } from '../jev/browser-contract';
import { evaluateComputerChoices } from '../automation/computer-choice-ids';
import { DEFAULT_COMPUTER_MIN_CONFIDENCE, DEFAULT_COMPUTER_MODEL, DEFAULT_COMPUTER_MODEL_TIMEOUT_MS, COMPUTER_MODEL_OAUTH_UNSUPPORTED, evaluateWithModel, messagesEndpoint, thinkingCredentialSupported } from '../automation/model-choice-evaluator';
import type { JevService } from '../jev/service';
import type { JevRequest } from '../jev/types';
import { agentIdentity, computerDecisions, gatewayJev } from './jev-gateway';
import type { TaskSnapshot } from './types';

type Evaluate = (task: TaskSnapshot, request: Parameters<ComputerUseDependencies['evaluate']>[0], signal: AbortSignal) => ReturnType<ComputerUseDependencies['evaluate']>;
const computerModel = (gateway: GatewayConfig) => gateway.gateway.computerUse?.model ?? DEFAULT_COMPUTER_MODEL;

/** Per-step decisions for Computer Use: Jev where it already served Computer Use, otherwise
 * (gateway.computerUse) the agent's own identity with a small model. Both paths keep opaque
 * choice IDs and readChoice validation via evaluateComputerChoices. */
export function computerEvaluator(gateway: GatewayConfig, agent: AgentConfig, member: (task: TaskSnapshot) => boolean,
  jev: () => Pick<JevService, 'evaluate'> = () => gatewayJev(gateway).service, fetchImpl?: typeof fetch): Evaluate {
  return (task, request, signal) => {
    const backend = computerDecisions(gateway, agent);
    // A live config change to the other backend (or off) revokes an in-flight decision.
    const authorize = () => member(task) && computerDecisions(gateway, agent) === backend;
    if (backend === 'model') return evaluateComputerChoices(request, wire => evaluateWithModel(wire, {
      model: computerModel(gateway), timeoutMs: gateway.gateway.computerUse?.timeoutMs ?? DEFAULT_COMPUTER_MODEL_TIMEOUT_MS,
      minConfidence: gateway.gateway.computerUse?.minConfidence ?? DEFAULT_COMPUTER_MIN_CONFIDENCE,
      connection: async () => agentIdentity('Computer Use'), authorize, fetch: fetchImpl,
      // Codes, sizes and token counts only; never request content or credentials.
      onEvaluation: event => console[event.outcome === 'failed' ? 'warn' : 'log'](JSON.stringify({ event: 'computer_model_evaluation', agentId: agent.id, taskId: task.taskId, ...event })),
    }, signal));
    return evaluateComputerChoices(request, wire => jev().evaluate(wire as JevRequest, { principalId: task.ownerPrincipalId, agentId: agent.id, sessionId: task.agentSessionId, taskId: task.taskId, consumer: 'computer', signal, authorize }));
  };
}

/** Field-filling Thinking: Jev's configured helper first; on the model backend, the same identity and model. */
export function computerThinking(gateway: GatewayConfig, agent: AgentConfig): BrowserTextHelperConfig | { resolve: () => Promise<ThinkingConfig> } | undefined {
  const configured = gateway.gateway.jev?.thinking ?? gateway.gateway.jev?.browser?.textHelper;
  if (configured || computerDecisions(gateway, agent) !== 'model') return configured;
  return { resolve: async () => {
    const identity = agentIdentity('Computer Use'), url = messagesEndpoint(identity.baseUrl);
    // Thinking sends x-api-key; refuse rather than send a Bearer-only token in the wrong header.
    if (!thinkingCredentialSupported(identity, url)) throw new Error(COMPUTER_MODEL_OAUTH_UNSUPPORTED);
    url.pathname = url.pathname.replace(/\/messages$/, '');
    return { api: 'anthropic-messages', baseUrl: url.toString().replace(/\/$/, ''), model: computerModel(gateway), apiKey: identity.apiKey };
  } };
}
