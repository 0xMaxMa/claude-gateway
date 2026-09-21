# Jev evaluations

Jev evaluates bounded state against typed questions. Use it to choose among observed options, score a rubric, or estimate the probability of a yes/no answer. It does not generate a conversational reply, grant permissions, or prove that an action succeeded.

The optional gateway service provides a single client for authorized agents, workers, API adapters and in-process features. Configure a direct TypeSafe connection or a compatible upstream. The gateway does not host the model or require any particular hosted platform.

## Configure a direct connection

Merge this fragment into your configuration:

```json
{
  "gateway": {
    "jev": {
      "enabled": true,
      "provider": "typesafe",
      "model": "jev-1.13.0",
      "apiKeyFile": "/path/to/private/jev.key",
      "allowedAgentIds": ["assistant"]
    }
  }
}
```

Store only the key in that file and restrict its filesystem permissions. Alternatively, set `apiKeyEnv` to the name of an environment variable available to the gateway process. Do not configure both references. Without either reference, direct mode reads `TYPESAFE_API_KEY` from the gateway environment.

Use a dedicated credential environment name such as `PRIVATE_JEV_TOKEN` or `GATEWAY_JEV_API_KEY`. Native CLI authentication/control names such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_HOME`, `HOME`, and `PATH` are rejected as `apiKeyEnv`. To reuse a native upstream identity, use the upstream resolver below instead of repurposing its environment variable.

The gateway removes `TYPESAFE_API_KEY`, `JEV_API_KEY` and configured Jev credential variables from child-process environments after applying overlays. It also excludes them from generated MCP/Codex shell environment overrides and masks them when launching container processes. Previously configured variable names remain private during the current gateway process after a hot reload. Gateway-created capability/skill probes, native MCP adapters and managed safemode requests use the same filtering. Managed safemode CLI descendants inherit a names-only exclusion policy so gateway dotenv loading cannot restore filtered credentials. Native CLI authentication variables and independently launched terminal CLIs keep their existing behavior. Remove retired secrets from service environments before restarting; use a key file if you want to avoid inherited environment credentials entirely. This prevents automatic forwarding, not arbitrary filesystem access by a separately privileged host tool.

Direct requests use `https://api.typesafe.ai/v1/systemone` by default. Model versions and aliases come from the [TypeSafe model catalog](https://docs.typesafe.ai/models); choose a supported version deliberately. The result records the actual version reported by the provider.

## Configure a compatible upstream

An upstream owns its catalog, account routing, credential storage and billing. Model IDs are opaque: the gateway forwards prefixes and slashes unchanged and does not interpret them as a billing source.

To reuse the gateway's existing upstream identity:

```json
{
  "gateway": {
    "jev": {
      "enabled": true,
      "provider": "upstream",
      "model": "catalog-prefix/jev-version",
      "allowedAgentIds": ["assistant"]
    }
  }
}
```

The resolver selects an endpoint and credential **as one group**. If Claude settings contain any of `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN`, that settings group must contain both a URL and a usable credential. Otherwise, the same group is read from the gateway's inherited environment. An incomplete settings group is an error; it is never combined with another identity's environment values. This does not modify native CLI authentication.

For an independent compatible provider, configure both the endpoint and a credential reference:

```json
{
  "gateway": {
    "jev": {
      "enabled": true,
      "provider": "upstream",
      "baseUrl": "https://inference.example.com",
      "apiKeyEnv": "JEV_UPSTREAM_KEY",
      "model": "catalog-prefix/jev-version"
    }
  }
}
```

An explicit upstream `baseUrl` requires an explicit credential reference, and vice versa. URLs require HTTPS, except HTTP on `localhost`, `127.0.0.1`, or `[::1]` for local development. URL credentials, query strings, fragments and redirects are rejected. Tool callers cannot supply a URL or key.

The default compatible path is `/v1/jev/evaluate`. A base ending in `/v1` or the full evaluation path is also supported. A leading deployment path is retained. This is the gateway's compatibility contract, not a claim that every inference provider already implements it.

## Access, limits and reload

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | Off | Explicit opt-in |
| `allowedAgentIds` | All agents when omitted | Restrict access; an empty array allows none |
| `timeoutMs` | `5000` | Entire evaluation, including queue wait and credential resolution |
| `maxConcurrentRequests` | `4` | Shared active evaluation limit |
| `maxQueueSize` | `16` | Bounded number waiting for a slot |
| `maxInputBytes` | `131072` | UTF-8 JSON request size; excess input is rejected |
| `maxQuestions` | `64` | Maximum question count; no silent truncation |

Each agent can set `jev.enabled: false` to narrow global permission. An agent cannot expand the global allowlist. Existing task/ticket/agent access checks still apply. An evaluation grants no additional access to another agent's tasks, memory or browser sessions.

`gateway.jev` and agent Jev access settings reload live. Each new request captures its configuration; an in-flight request retains that model/connection generation. Access and global enablement are checked again before dispatch and before returning an answer. Revocation discards the decision, although a request already sent may still incur provider usage. Key files are read for each request, allowing rotation without restart. Changing a parent shell variable does not update the environment of an already running gateway.

There are no automatic retries or automatic switches to another billing source. A timeout or cancelled request does not establish that the provider did no work or charged nothing.

The `features` block reserves `browserTasks`, `skillRouting`, `progressFiltering`, and `conversationIntake` enable flags. These do not automatically install a browser adapter or activate future classification features. See the implementation boundary below.

## Typed questions and answers

State and instructions accept text, a JSON object, or a JSON array. The service validates the full response against every question, including allowed options, probability ranges/distributions, score levels and nonnegative integer usage. Unexpected answer keys or missing answers fail the request.

```json
{
  "state": "The user wants to compare two options before deciding.",
  "questions": {
    "needs_decision": {
      "type": "noul",
      "instructions": "Does the user still need to make a decision?"
    },
    "next_step": {
      "type": "choice",
      "instructions": "What is the appropriate next step?",
      "criteria": {
        "explain": "Compare the options for the user.",
        "execute": "Execute a clearly authorized choice."
      }
    },
    "clarity": {
      "type": "score",
      "instructions": "How clear is the requested action?",
      "criteria": ["Unspecified", "Partially specified", "Fully specified"]
    }
  }
}
```

- **Noul:** `{ "type": "noul", "noul": 0.8 }`. The number is a yes probability, not a fabricated confidence field.
- **Choice:** chosen option, a probability for every option, and confidence. Supports 1–255 options.
- **Score:** probability-weighted score, indexed level probabilities, a legend, and confidence. Supports 2–10 levels.

Consumer policy belongs outside the client. Browser operation confidence, target confidence, skill relevance and progress filtering need different decisions and thresholds. A high probability is never authorization.

## MCP and worker access

Authorized orchestrators and workers can use `mcp__gateway__jev_evaluate` with `state` and `questions`. The gateway derives agent/session/task identity from authenticated runtime context; these fields, provider URLs, model overrides and keys are not tool arguments.

The same service is used for Claude Code and Codex workers, including app-container bridges. Vendor keys remain outside the container. Capability discovery and tool availability still depend on the current agent's permissions and process inventory; merely enabling Jev does not bypass those checks.

An external MCP server does not automatically gain access to another server's tools. Use the authenticated HTTP API with an agent-scoped write key, or inject an in-process evaluation callback into an adapter. Do not delegate an admin key.

## HTTP evaluation and usage

`POST /api/v1/jev/evaluate` requires an API key with write access to the specified agent, plus enabled Jev access for that agent. Evaluation is treated as a paid action. A read-only key cannot initiate it.

```bash
curl --fail-with-body http://127.0.0.1:10850/api/v1/jev/evaluate \
  -H "Authorization: Bearer $CLAUDE_GATEWAY_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"agentId":"assistant","state":"Hello","questions":{"greeting":{"type":"noul","instructions":"Is this a greeting?"}}}'
```

Successful gateway response:

```json
{
  "requestId": "opaque-request-id",
  "requestedModel": "catalog-prefix/jev-version",
  "model": "jev-1.13.0",
  "answers": { "greeting": { "type": "noul", "noul": 0.99 } },
  "usage": { "input_tokens": 120, "output_tokens": 8 }
}
```

Optional `billing` contains `charged_credits` and an optional `rate_version`, as reported by the compatible upstream. These are not inferred from token counts or multiplied again by the gateway.

`requestId` is optional on requests. Reusing an ID within the same caller scope is rejected rather than silently repeating a paid request. The local ledger is bounded and retained for five minutes; it is not durable across gateway restarts. Upstream IDs are hashed and caller-scoped. Durable deduplication and billing reconciliation belong to the upstream; a conflict response is not a cached answer.

Read usage with `GET /api/v1/jev/usage?agentId=assistant&limit=50&offset=0`. The API returns `{ "records": [], "total": 0 }` when no measurements exist. Read access to that agent is required. `limit` is 1–100 and `offset` is nonnegative. Usage records contain metadata, latency, outcome, model, reported usage and optional billing, never raw state, questions, DOM or credentials. The local store retains at most 10,000 records. Jev requests are separate from conversational context-window tokens.

Errors expose a typed `JEV_...` code where the evaluation service handles the failure: invalid request/configuration, access denial, missing credentials, unsupported model, quota, rate limit, timeout, cancellation, provider failure, malformed response or request conflict. Safe retry/reset headers are retained when supplied; raw provider error bodies are not exposed because they can contain submitted state or credentials.

## Compatible upstream wire contract

The gateway sends this provider request, authenticated with the selected upstream credential:

```json
{
  "request_id": "caller-scoped-request-id",
  "model": "catalog-prefix/jev-version",
  "state": "Hello",
  "questions": { "greeting": { "type": "noul", "instructions": "Is this a greeting?" } }
}
```

The compatible upstream returns native `model`, `answers`, and `usage` in the TypeSafe shape, plus `request_id` and `requested_model` to identify the submitted request. Optional billing uses the shape above. Extra provider-specific routing metadata is not exposed as authorization. Direct TypeSafe requests contain only `model`, `state`, and `questions`.

The gateway distinguishes native version from requested catalog ID. A prefixed catalog identifier must never be replaced with an unprefixed native model before upstream routing.

## Browser runner adapter boundary

`src/jev/browser-runner.ts` exports `runBrowserTask()` and `BrowserTransport` for compatible local integrations. It is a transport seam, not a built-in remote browser connection or an automatic browser deployment.

A transport supplies:

1. `observe(signal)` — bounded state, revision/fingerprint, and supported opaque action handles.
2. `checkAccess(observation, action, signal)` — current principal/grant/tab ownership and observation freshness checks.
3. `execute(input, signal)` — enforce the same owner/revision fence atomically at the side effect.
4. `verifyCompletion(observation, signal)` — fresh independent evidence for the actual goal.

Example integration outline:

```ts
const result = await runBrowserTask({
  goal: 'Open the requested result',
  transport: authorizedBrowserTransport,
  evaluate: (request, signal) => jevService.evaluate(request, {
    principalId: taskPrincipal,
    consumer: 'browser',
    agentId,
    taskId,
    signal,
    authorize: currentTaskMayUseJev,
  }),
  fieldValues: { search: 'Explicit user-supplied search text' },
  budget: { maxSteps: 20, maxEvaluations: 20, timeoutMs: 60000 },
  signal: taskSignal,
});
```

The runner checks operation and target confidence separately, rejects unsupported/mismatched actions, bounds repeated no-progress observations, and requests explicit missing field values instead of asking Jev to generate prose. It rechecks access after inference. A model-selected DONE is followed by fresh observation and independent verification; otherwise the result is `needs_verification`.

Cancellation/disconnection during a possible mutation returns an uncertain outcome and never automatically replays that action. The adapter must honor abort signals and fence side effects itself. The orchestration runtime can register the included `BrowserTaskAdapter` when a trusted host supplies `host.browserBindings()`. Each version-1 binding has an opaque target ID, name, exact principal ID, exact conversation ID, and a `BrowserTransport`; optional field values and budgets come from the trusted binding, not a model-supplied URL. Enable `gateway.jev.features.browserTasks.enabled` as well as Jev access. Without a host binding, there is no browser target to discover. App-container agent schemas expose the browser discovery scope and browser-only managed-task target only when this integration and permission are enabled at process creation. This does not expose safemode or arbitrary host execution. Existing process inventories remain captured, while every call still checks current access.

Discovery and resolution only return bindings owned by the calling principal **and** conversation, including conversations that share an agent. The adapter runs through the existing gateway-managed task controller, persists a receipt before browser work, and records a verified result separately for each task/request. A receipt left running after restart becomes an uncertain result; the request is not automatically submitted again. Cancelling one task cannot cancel another request with a reused ID. Access is rechecked while the task runs, including after completion verification.

The included adapter does not issue browser grants or arbitrate tabs across gateways. The actual browser transport must enforce those controls. A missing explicit field value produces a handoff/unknown task outcome requiring reconciliation; this version does not invent field text or automatically create an interactive form-question workflow. No concrete browser product is installed or connected by enabling this flag.

The deterministic tests use a fake transport to verify these boundaries. They are not live-browser performance or success-rate measurements. Progress filtering and conversation-intake integrations remain future opt-in consumers; no token-saving claim follows merely from making this evaluator available.

## Optional skill recommendations

`src/jev/skill-routing.ts` exports `recommendJevSkills()` for integrations that already know the **effective authorized skill catalog** for the current principal, worker harness, and host or container. This is an opt-in metadata helper, not an installed Claude Code/Codex hook. Setting a feature flag alone does not automatically discover skills or change native worker routing.

The caller supplies stable local IDs, names, descriptions, and applicability flags. Only task context and names/descriptions go to the evaluator; the helper does not read or transmit skill files, local paths, plugin configuration, or full bodies. Supply a short current-task description with enough context for follow-ups, rather than the whole conversation. Do not put secrets or filesystem paths inside the names/descriptions themselves.

```ts
const routing = await recommendJevSkills({
  enabled: config.features?.skillRouting?.enabled === true,
  nativeRoutingActive: nativeSkillPluginAlreadyHandlesThisInput,
  task: currentInstruction,
  context: currentTaskSummary,
  catalog: authorizedEffectiveCatalog,
  explicitIds: explicitlyRequestedSkillIds,
  requiredIds: requiredSkillIds,
  ongoingIds: ongoingTaskSkillIds,
  catalogVersion: version,
  currentCatalogVersion: () => effectiveCatalogVersion(),
  evaluate: (request, signal) => jevService.evaluate(request, {
    principalId,
    agentId,
    consumer: 'skill-routing',
    signal,
    authorize: currentPrincipalMayUseJev,
  }),
  signal: taskSignal,
});
```

Explicitly requested, required, and ongoing skills are retained separately and are not scored. Disabled, inaccessible, and manual-only entries are excluded from **optional** recommendations. Explicit manual-only skills remain eligible to be preserved. A missing, disabled, or inaccessible required entry triggers native fallback instead of silently dropping the requirement; the native path still enforces current permissions.

Each optional skill receives an independent Noul relevance probability, so multiple skills can be recommended. The default threshold is `0.6`; it is configurable by the integration and is not proof that a skill is correct. Low probabilities produce no optional recommendation, without being treated as an API error.

All candidates must fit the configured batch, request-size, and total-time bounds. The helper validates every planned batch before the first evaluation, never silently truncates the catalog or context, and falls back to native selection on oversized input, invalid or missing answers, errors, cancellation, or catalog-version changes. A failed later batch discards earlier partial recommendations. Defaults are 32 candidates per batch, 32 batches, 64 KiB per request, and a 10-second deadline for the entire operation; configure these to fit the shared evaluation service's limits.

Use `mode === 'native'` to keep ordinary skill selection. With `mode === 'recommended'`, retain `preservedIds` and map `recommendedIds` back to the still-authorized local catalog before reading skill bodies. Recommendations grant no MCP/tool access and never prevent the worker from discovering additional skills later. Coordinate with native routing plugins: if one already owns this input, pass `nativeRoutingActive: true` so this helper does not issue duplicate requests.

No automatic native hook is installed by this helper, and no measured token saving is claimed. Selecting metadata does not unload tool schemas. Integrations must measure actual loaded context and task quality before enabling routing broadly.

## Check readiness and troubleshoot

Run `claude-gateway doctor` after editing configuration. When Jev is enabled, its local check validates the configuration and checks referenced credential-file readability/size or the direct credential environment reference. It does not prove upstream authentication or perform paid Jev inference. Use the bounded HTTP example above when you explicitly want to test the configured provider end to end.

- **Configuration rejected:** check the provider/model, numeric limits, credential reference and complete endpoint/credential group.
- **No tool:** check global enablement, `allowedAgentIds`, agent disablement and the current runtime's tool inventory.
- **Authentication failure:** verify the file/environment is readable under the gateway's service user. A key configured only in an interactive shell may not exist in the service environment.
- **Quota or rate limit:** inspect the upstream account and supplied retry/reset metadata. The gateway does not switch to a different account automatically.
- **Malformed response:** verify that the upstream implements structured evaluation rather than returning a chat completion or event stream.
- **Browser did not complete:** inspect handoff/unknown outcomes and independent evidence. Do not turn `needs_verification` into success or retry an uncertain mutation automatically.
