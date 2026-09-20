# Worker harnesses

The conversational Agent continues to run Claude Code. Background workers default to automatic routing: GPT models use native Codex when its runtime and portable native authentication are ready, otherwise they fall back to Claude Code before dispatch. Other models use Claude unless model metadata selects another harness. Explicit `claude` or `codex` selections are preserved. The gateway's task lifecycle and scoped MCP tools apply to both harnesses.

## Configure routing

Omitting `workers.harness` uses `auto`; existing configurations do not need migration. To configure routing explicitly, set `gateway.workers` below. Use `harness: "claude"` to keep all workers on Claude Code, or `harness: "codex"` to require Codex and report readiness failures. Restart the gateway while idle to apply harness changes:

```json
{
  "gateway": {
    "workers": {
      "harness": "auto",
      "codex": {
        "reasoningEffort": "medium"
      }
    }
  }
}
```

The optional `codex.baseUrl` and `codex.apiKeyEnv` fields are **explicit overrides**.
Omit both to use the provider selected by native Codex configuration under the
gateway service user's `CODEX_HOME` (default `~/.codex`). Log into Codex separately;
gateway never copies Claude credentials and never installs or logs into Codex for you.
Native API-key file login and selected providers using `env_key` are supported.
With overrides, set the named environment variable in the service environment;
existing explicit settings retain precedence. URLs must expose Responses over
HTTPS (local HTTP is allowed), without embedded credentials or query strings.

`harness: "auto"` selects Codex for GPT model IDs when its runtime and isolated
worker credentials are ready. Otherwise it selects Claude **before dispatch**
and records a `worker.harness_fallback` event. A Codex turn that has started is
never replayed through Claude after an auth, quota, network or execution error.
Explicit `harness: "codex"` fails with a readiness error rather than switching.

Agent-level worker settings override gateway defaults. Native OAuth/ChatGPT and
OS-keyring login remain available in **safemode**, where Codex owns its original
auth store and refresh lifecycle. They are currently **not portable to isolated
workers**: auto routing falls back to Claude with `CODEX_AUTH_NOT_PORTABLE`.
Gateway does not copy rotating refresh tokens or mount a personal Codex home.
Use native API-key file login or an `env_key` provider for Codex workers.

Existing model entries in `gateway.models` can declare worker routing and provider model names:

```json
{
  "id": "gpt-5.6-luna[1m]",
  "alias": "fast-worker",
  "workerHarness": "codex",
  "workerModel": "gpt-5.6-luna"
}
```

`workerHarness` affects automatic routing. `workerModel` maps a gateway selection to the native provider model. Without an explicit mapping, native model names drop only Claude context suffixes such as `[1m]`; provider namespaces such as `chatgpt/` are preserved so BYOK routing cannot silently switch to a managed pool. Available reasoning settings are `low`, `medium`, `high`, and `xhigh`; support depends on the chosen model/provider. `codex.bin` may specify an executable path, not a shell command with arguments.

Runtime/auth preflight can fall back only in auto mode. Endpoint/model/quota failures after dispatch fail the task explicitly. App tasks never fall back to host execution.

Relative `codex.bin` paths resolve against the agent workspace; the credential probe and worker use that same resolved executable. A native provider using HTTP at `host.docker.internal` is accepted only for app-container workers, not host workers. The container must have that hostname mapped to the gateway host.

## Deploy app containers

Generated app-agent images do **not** download or install Codex. Claude-only apps work without a host Codex installation. To enable Codex, explicitly install an official standalone or npm Codex distribution on the gateway host. The resolver uses the effective agent `workers.codex.bin`, then the gateway value, then the gateway process's `PATH`. It resolves executable symlinks and finds the native payload and bundled resources behind an npm launcher. Host workers retain the npm launcher; app workers use the native executable at `/opt/gateway-codex/bin/codex`.

Only when a compatible runtime and portable native auth are ready are the native executable and recognized bundled resource paths mounted read-only. Host Codex home, authentication, configuration and sessions are not added to the container. Per-attempt state and credential delivery remain isolated. A missing executable, incompatible layout, unavailable mount or unportable auth never causes installation or host execution. Auto mode can select the Claude container worker before dispatch. All agents sharing an app container must resolve to the same native runtime; conflicting overrides leave Codex unavailable until aligned and refreshed.

Container mounts require a local Linux Docker daemon on the gateway host, matching x64 or arm64 architecture. Remote Docker and Docker Desktop are unsupported. Official self-contained distributions are supported; custom host launcher scripts may work for host workers but cannot be mounted. ELF format/architecture and resources are checked before mounting; arbitrary external shared-library dependencies are not packaged for you. `claude-gateway doctor` reports resolved executable/version and layout compatibility, but cannot certify every container image or the running service's PATH. Run diagnostics in the gateway service environment when an interactive shell gives different results.

### Install, upgrade or refresh a runtime

Each Codex task checks the selected runtime against the container's generated mount fingerprint and verifies the mounted executable's SHA-256. A late host install, a changed override, or an upgrade returns `CODEX_CONTAINER_RUNTIME_STALE` until the agent is refreshed. It never recreates a container underneath running work.

1. Drain tasks and pause new work for the app agent. Keep other launchers from starting it during maintenance.
2. Stop **only** its agent service with `docker compose -p APP_NAME -f /absolute/app/docker-compose.yml stop agent`.
3. Run `claude-gateway app refresh-runtime APP_NAME --config /path/to/config.json` on the gateway/Docker host.
4. Run `claude-gateway doctor --config /path/to/config.json`, then retry a Codex task.

Native Codex transcripts live in the container's writable layer. Normal reuse within
one container resumes its native conversation. After recreation, the gateway detects
the new Docker container ID and starts a fresh native conversation with the task's
current assignment/context, emitting `native_session_reset`. It does not pretend the
old transcript survived or retry a missing path. Older mappings without a container ID
resume only when their transcript directory still exists. Gateway task history remains
on the host; previous native conversation context is not preserved by recreation.

Docker context/info/inspection preflights run asynchronously with bounded timeouts,
so a slow Docker daemon does not block gateway HTTP, voice processing or timers.

The refresh command refuses running/restarting containers, verifies installer ownership and isolation, backs up generated files under `.gateway-agent-migrations`, regenerates mounts, rechecks the stopped container identity and recreates **only** `agent` with `--no-deps --no-build`. App/database services and volumes are untouched. The existing generated image can be reused; no Codex image rebuild is required. Refresh is also supported for older generated deployments and deleted old runtime paths when their mounts match the saved generated Compose specification. Missing optional Codex still permits refresh; the success message does not imply Codex was installed.

On failure the generated files are restored and the backup retained. The command does not automatically recreate a rejected old container or claim to roll back an already recreated container. Inspect the error and backup before explicit recovery. Docker does not provide an atomic stopped-state/Compose recreation transaction, so keep the agent stopped until this command takes ownership of the recreation.

Removing host runtime files while their mounts are still configured can also block Claude admission: the gateway refuses to trust unresolvable host mounts. Use the same stopped-agent refresh to remove those mounts. Removing Codex entirely then leaves a Claude-only deployment functional.

Execution stays inside the admitted app container under its normal UID and security restrictions. The gateway bridges only the existing scoped container task tools: progress reporting, requesting input, staging files, and agent-owned cron schedules. Scoped cron tools can schedule agent prompts; host commands and immediate `cron_run` remain unavailable in containers. Container workers do not gain host media/browser/memory access. Missing or rejected container bindings never select a host process.

Expired or replaced Codex session homes are reclaimed in bounded background batches when another worker starts. Warm pool sessions and active leases are retained. Leases left after a crash or unconfirmed process stop are conservatively preserved; cleanup does not assume those processes have stopped. Unknown legacy metadata is not deleted automatically.

## Run the opt-in smoke benchmark

The repository includes a small billable benchmark of the two native CLIs:

```bash
node scripts/orchestration/benchmark-worker-harnesses.cjs --run \
  --claude-model 'gpt-5.6-luna[1m]' \
  --codex-model gpt-5.6-luna \
  --output /tmp/worker-benchmark.json
```

Without `--run`, the script only prints usage. It uses existing local CLI authentication, runs one worker at a time with a 120-second limit, and creates separate scratch fixtures. Each worker implements the same integer-sum function; an independent Node harness checks normal inputs, invalid inputs, and overflow. Scratch files are removed afterward. No gateway configuration changes are made.

For an explicit Responses endpoint, add `--codex-base-url https://your-provider.example/v1 --codex-api-key-env OPENAI_API_KEY`. Use `--claude-base-url` to select the Anthropic-compatible route separately. Credentials remain in environment variables or existing CLI authentication storage; never pass the secret as an argument. The script loads only Claude credential/endpoint environment keys from local Claude settings and tells Codex to ignore user configuration and policy rules while retaining authentication. Missing credentials produce a clear skipped result and unsuccessful exit status. Unavailable CLIs and provider failures also produce unsuccessful status; they do not trigger fallback.

Explicit environment values take precedence over local settings. To compare both routes with a chosen credential, use `--claude-api-key-env BENCHMARK_KEY --codex-api-key-env BENCHMARK_KEY`; this selects Claude's bare API-key mode and disables local setting sources so saved environment settings cannot overwrite the chosen credential. Otherwise Claude retains its normal authentication behavior. Codex uses `workspace-write` sandboxing by default. The optional `--host-execution` switch instead matches an explicitly authorized host worker's execution permissions and is recorded in the report; use it only on a suitable test host.

The JSON report contains correctness, elapsed time, CLI status, tool/provider error counts, and available input/cache/output token totals. It does not save raw provider output, account identifiers, credential files, or endpoint URLs. Token accounting differs between CLIs; unavailable values are `null`.

Codex reports inclusive input tokens. When supplied, `cacheWriteInputTokens` in App Server events and `cache_write_input_tokens` in CLI output are recorded as cache creation separately from cached reads. Fresh input subtracts both measured categories from inclusive input. A measured zero differs from an absent field; do not infer a cache write from prompt length or a billing discount. Caching options supported by the public OpenAI API may differ from those accepted by a subscription-backed endpoint.

Native events and the benchmark retain that presence distinction. Existing gateway usage aggregates normalize missing cache-creation counters to zero, so a dashboard zero alone does not prove the upstream explicitly reported zero.

This is a native CLI coding smoke check, **not** a gateway integration benchmark or proof of quality parity. Different endpoint/account routes, cache state, model mappings, and CLI settings can affect results. A timing or token difference does not establish a controlled cost comparison. Test real gateway tasks separately, including MCP calls, cancellation, progress/checkpoint behavior, and container execution.

## Custom connectors

Eligible host workers use the same enabled custom connector configuration in both
Claude and Codex. Each attempt receives private lazy-connector proxies, including
HTTP connectors; connector credentials are removed with the attempt's temporary
configuration. Agent opt-outs and gateway defaults apply to both harnesses.
Container and isolated workers do not receive host custom connectors.

To verify the native Codex proxy path without provider billing, run
`node scripts/orchestration/smoke-codex-worker.cjs --connector` from a development
checkout with Codex and the MCP dependencies installed. This uses a local fake
Responses server and a fixture MCP connector; it does not test a real vendor.

## Container runtime smoke test

From a development checkout with Docker and Codex installed, run:

```bash
node scripts/orchestration/smoke-codex-worker.cjs --container
```

This creates a temporary plain Debian container, mounts the resolved host Codex runtime read-only, and uses a local fake Responses API. It verifies scoped MCP, native resume, steering and cancellation without provider billing. The temporary container is removed afterward. It does not change a running gateway or installed app.


## Native capability boundaries

Gateway workers disable native notification programs, hooks, plugins, apps, browser/computer tools, image generation, shell snapshots, native multi-agent and automatic skill/dependency installation before starting Codex. They use the gateway-selected MCP configuration; unexpected effective capabilities or interactive approval requests fail the attempt. Explicit shell commands and coding tools remain available within the authorized worker profile.

For app workers, Docker is the filesystem and process boundary (`externalSandbox`). Workers can edit the app workspace and writable container layer and use network access. Tasks sharing the same app container are not separate security identities. Host-execution workers remain trusted with the host user's authority; a worktree is not an OS sandbox. These controls prevent unintended native integrations, not arbitrary actions by a trusted worker with shell access.
