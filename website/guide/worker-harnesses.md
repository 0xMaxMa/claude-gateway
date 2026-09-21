# Worker harnesses

The conversational Agent continues to run Claude Code. Background workers default to automatic routing: GPT models use native Codex when its runtime and native authentication are ready, otherwise they fall back to Claude Code before dispatch. Other models use Claude unless model metadata selects another harness. Explicit `claude` or `codex` selections are preserved. The gateway's task lifecycle and scoped MCP tools apply to both harnesses.

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
Native API-key login (file or OS keyring), ChatGPT login (browser or device login), and selected providers using `env_key` are supported. The gateway asks the installed Codex app-server for its selected account and access credential; it does not parse a particular auth-file layout. File, keyring and auto credential storage remain owned by Codex.
With overrides, set the named environment variable in the service environment;
existing explicit settings retain precedence. URLs must expose Responses over
HTTPS (local HTTP is allowed), without embedded credentials or query strings.

`harness: "auto"` selects Codex for GPT model IDs when its runtime and isolated
worker credentials are ready. Otherwise it selects Claude **before dispatch**
and records a `worker.harness_fallback` event. A Codex turn that has started is
never replayed through Claude after an auth, quota, network or execution error. Installed file-backed Claude plugin skills can run through Codex, including their plugin-root resources. A genuinely native command with no transferable skill file still reports `CODEX_SKILL_UNAVAILABLE`; automatic routing records a pre-dispatch fallback rather than inventing its instructions.
Explicit `harness: "codex"` fails with a readiness error rather than switching.

Agent-level worker settings override gateway defaults. Host workers and app-container workers use the same native login as terminal Codex. For ChatGPT, the host CLI exports only the current access token through `getAuthStatus`; an isolated app-server receives it through `account/login/start` with `chatgptAuthTokens` and ephemeral storage. Refresh requests go back to the host CLI, concurrent refreshes are coalesced, and an account change fails the running worker rather than switching identities. Gateway never copies refresh tokens, writes native auth configuration, or mounts a personal Codex home into a container. Safemode continues to use the native auth store directly.

Local readiness is not a live provider test: subscription model access, quota and connectivity can still fail after dispatch. An installed CLI that cannot export its selected authentication reports a specific readiness error; auto routing falls back before execution. Custom providers needing extra headers, query parameters or provider-specific signing require additional support and are not silently remapped. Terminal-only environment settings must also be available to the gateway service user.

Worker Turn details, task attempt details and `/tasks` detail show **Harness: Codex** or **Harness: Claude Code** from the recorded attempt, including the actual result of auto fallback. Historical attempts without a recorded harness are not inferred from model names. `doctor` groups agents sharing the same executable/auth configuration and reports distinct readiness failures once per configuration.

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

### Context windows

Context suffixes express a request, not a guarantee: `[1m]` requests 1,000,000
raw tokens and `[200k]` requests 200,000. Without a suffix, configured model
metadata supplies `contextWindow`; otherwise native defaults apply.

**No additional user configuration is required.** Select the model normally.
Gateway applies known model limits and records native measurements automatically.
The same policy runs on host and app-container workers.

Versioned model data lives in `src/session/codex-context-defaults.json`, and the
resolution/measurement rules live in `src/session/codex-context.ts`. Maintainers
can update model data in one place as official specifications change; users do
not maintain a second model-size catalog in `config.json`.

The initial safety entry caps GPT-5.4-mini at its documented 400,000-token limit,
including its explicit OpenAI/ChatGPT IDs. Codex 0.155.1 can otherwise match Mini
to GPT-5.4's larger window. These are exact model matches, not prefix/family rules.
Unknown models have no invented provider ceiling; native measurements remain
available but upstream capacity is unverified. Gateway does not raise Codex's
own catalog maximum to force a requested 1M window.

Gateway writes the bounded value to `model_context_window` and verifies it through
`config/read`. It leaves `model_auto_compact_token_limit` unset so native Codex
computes its default using native model metadata rather than an oversized requested
window. It does not change the user's global Codex configuration or catalog.

Worker turn details in the token report and dashboard show **Requested**, **Configured**,
**Provider ceiling**, and **Native context** separately. The native denominator comes
from `thread/tokenUsage/updated.modelContextWindow`; the numerator is the latest
request's `last.totalTokens`, never accumulated tokens across all requests.
Missing measurements show `—`. Recorded older turns are not retroactively guessed.
Conversational agent `/session` and its report header still describe the Claude Code
agent; worker context is separate and must not replace the agent's measurement.

For example, Codex 0.155.1 can cap Luna at 872,000 raw / 828,400 usable tokens even
with a 1M request. Its account and bundled catalogs may differ. A smaller native
window is displayed explicitly; neither the configured size nor the native
measurement certifies provider acceptance.

To audit a CLI update without paid inference, run
`node scripts/orchestration/audit-codex-context.cjs --output /tmp/context-audit.json`.
The optional `--models-json` accepts an array of model entries, and `--catalog-json`
replays a `codex debug models` snapshot in a temporary audit home. It uses the real
native app-server with a local Responses fixture, **not a large upstream request**.

Runtime/auth preflight can fall back only in auto mode. Endpoint/model/quota failures after dispatch fail the task explicitly. App tasks never fall back to host execution.

Relative `codex.bin` paths resolve against the agent workspace; the credential probe and worker use that same resolved executable. A native provider using HTTP at `host.docker.internal` is accepted only for app-container workers, not host workers. The container must have that hostname mapped to the gateway host.

## Worker command environment

Configure explicit worker environment values through `gateway.workers.environment`.
An agent's `workers.environment` overrides matching keys and inherits the remaining
gateway values. These settings apply to **workers of both harnesses**, not to the
conversational Agent, interactive safemode, or separately launched terminal CLIs.
With no settings, native shell behavior is preserved.

This partial configuration enables a Bash startup hook on host workers:

```json
{
  "gateway": {
    "workers": {
      "environment": {
        "BASH_ENV": "/home/example/.config/worker/bash-env.sh"
      }
    }
  }
}
```

Use absolute paths appropriate to the gateway service user. Values are literal
strings: the gateway does not expand `~`, `$HOME`, shell expressions, or variables
inside them. Hooks must already exist and be readable by that user. Keep credentials
in the CLI's existing credential store rather than placing them in this map.

The gateway passes these values to the worker process. For Codex it also writes
them into the private attempt's `shell_environment_policy.set` and checks the
effective `config/read` response before starting the native thread. Worker-pool
bindings include configuration and workspace, preventing reuse of a worker
transcript across incompatible execution settings.

### Bash and zsh startup differ

`BASH_ENV` is read by noninteractive Bash; it does not configure zsh.
Noninteractive `zsh -lc` does not read `.zshrc`. The installed native Codex
may select its default shell from the OS account, so setting `SHELL=/bin/bash`
alone is not a reliable shell override. The gateway does not force a shell,
source the user's entire interactive startup file, or modify the OS login shell.

If both shells must load the same compatible hook, explicitly configure
`BASH_ENV` and a dedicated `ZDOTDIR` containing a small `.zshenv`:

```json
{
  "gateway": {
    "workers": {
      "environment": {
        "BASH_ENV": "/home/example/.config/worker/account-routing.sh",
        "ZDOTDIR": "/home/example/.config/worker/zsh"
      }
    }
  }
}
```

Create `/home/example/.config/worker/zsh/.zshenv`:

```sh
. /home/example/.config/worker/account-routing.sh
```

The hook must be compatible with each shell that loads it. An explicit `ZDOTDIR`
also changes where zsh looks for its other user startup files; use this dedicated
directory deliberately rather than copying terminal themes or interactive plugins.

A path-based `gh` function needs **both** the startup hook and the intended
current directory. `git -C /project` and `gh --repo owner/repository` do not change
the shell's current directory, and Git commit identity does not select a GitHub
CLI account. Verify the effective shell with `type gh`, then perform a read-only
`gh api user --jq .login` in the intended project directory. Avoid global
`gh auth switch` when concurrent workers use different accounts.

### Container environment

App workers use `gateway.workers.containerEnvironment`, with matching
`agents[].workers.containerEnvironment` keys taking precedence. They never inherit
the host `workers.environment` map. Container paths, executables, hooks, and CLI
credentials must already be available through the app's authorized setup; these
settings do not copy or mount host files. Container environment values are passed
to Docker by variable name, not embedded in process arguments.

Environment maps accept at most 64 variables with string values. Runtime-owned
variables such as `HOME`, `PWD`, `CODEX_HOME`, and gateway/CLI authentication
variables are reserved. Changing worker environment does not replace native
Codex authentication.

## Project working directory

Set an agent's default project directory without changing its identity workspace:

```json
{
  "orchestration": {
    "tasks": {
      "workspaceMode": "host",
      "projectRoot": "/home/example/projects/application"
    }
  }
}
```

Merge this partial object into the relevant `agents[]` entry. The Agent's
`workspace` still holds its identity and memory; its workers start in the configured
project. Claude Code and Codex use the same resolved task workspace.

For an individual host task, the Agent can supply `working_directory` to
`task_spawn`. It must be an absolute, user-authorized directory. Precedence is:
explicit task directory, prior host task directory for a continuation, configured
project root, then the Agent workspace. Native thread startup uses that resolved
directory; this does not create a new Git worktree. A missing directory fails
startup instead of silently choosing another checkout.

`working_directory` is unavailable for container or isolated/shared workspace
modes; it cannot switch those workers to host execution. App workers remain in
`/workspace`. Existing queued tasks keep their recorded resource profile;
changing defaults affects newly created tasks. Restart the gateway while idle
after updating these settings, then verify a newly dispatched task.

## Deploy app containers

Generated app-agent images do **not** download or install Codex. Claude-only apps work without a host Codex installation. To enable Codex, explicitly install an official standalone or npm Codex distribution on the gateway host. The resolver uses the effective agent `workers.codex.bin`, then the gateway value, then the gateway process's `PATH`. It resolves executable symlinks and finds the native payload and bundled resources behind an npm launcher. Host workers retain the npm launcher; app workers use the native executable at `/opt/gateway-codex/bin/codex`.

Only when a compatible runtime and native auth are ready are the native executable and recognized bundled resource paths mounted read-only. Host Codex home, authentication, configuration and sessions are not added to the container. Per-attempt state and credential delivery remain isolated. A missing executable, incompatible layout, unavailable mount or unavailable native auth never causes installation or host execution. Auto mode can select the Claude container worker before dispatch. All agents sharing an app container must resolve to the same native runtime; conflicting overrides leave Codex unavailable until aligned and refreshed.

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

## Tool and timing measurements

Turn details show the recorded harness, model and elapsed execution time. Codex
command execution is labelled **Shell**; Claude Code retains **Bash**. Used tools
count distinct executed tools, not the number of calls.

On supported native Codex versions, the gateway reads its per-attempt rollout
trace to measure schemas actually included in model requests, including MCP
namespaces, and correlate per-request token usage. Code Mode measurements include
explicit callable declarations embedded in its execution tool; response
continuations retain the schemas observed in their referenced response. This works on the host and
inside app containers; only tool names and numeric usage leave the container.
Raw trace payloads are removed after extraction and the trace directory is removed
when the attempt stops. No provider URL or authentication routing is changed.
Interrupted process cleanup may leave private attempt artifacts until recovery.

Loaded counts distinct observed schemas, not the installed MCP catalog. Missing
measurements remain **—**, including older attempts and CLI versions without the
supported trace format. An in-flight request can have measured schemas before its
token usage arrives. These observations do not generate model requests or billing.

## Custom connectors

### Installed CLI extensions

Codex workers receive a metadata catalog of enabled Claude and Codex skills. Full
instructions are read only when needed. Named task skills pin their instructions
at admission; plugin-root resources such as `shared/foundation.md` retain their
relative layout. Nested skill invocations are resolved through the catalog, and
unique short names are included as aliases. Disabled plugins, unrelated project
installations and arbitrary stale cache versions are excluded. If a native plugin
metadata request fails, discovery reports a notice and preserves successfully
discovered skills, configured MCP servers and other plugins.

The gateway asks native Codex for its installed skills and plugins. It also reads
enabled Claude plugin manifests, user/project skills and commands. The Agent can
advertise these extensions even though execution belongs to a worker. A native
Claude `Skill` call is not required to read and follow a portable workflow.

Codex workers discover MCP tool schemas on demand through `tool_search`, then
invoke the original tool through `tool_call`. Claude-configured stdio, Streamable
HTTP and SSE servers retain their configuration and project consent. Native Codex
MCP uses a discovery-only native sidecar so Codex continues to own its OAuth/keyring
connections and tool restrictions. The sidecar creates no model turn. Native
connection consent and policy approvals are not silently accepted.

App workers discover extensions **inside the app container**. They do not inherit
host personal MCP servers, credential homes or host executable paths. Their MCP
adapter is the same proxy bundled as a standalone Node module and executed inside
the container; no extra Bun installation or host MCP execution is needed there.
Gateway-provided task skills remain explicitly copied into their scoped attempt.

Codex user-input requests enter the existing task question flow, releasing the
worker slot until the user answers. Executable Claude hooks, native Claude agent
APIs and arbitrary CLI-specific commands are not automatically translated into
Codex equivalents. Instructions do not grant extra tools or bypass container
permissions. Missing connection credentials or native-only dependencies must be
reported rather than claimed to work.

Eligible host workers use the same enabled custom connector configuration in both
Claude and Codex. Each attempt receives private lazy-connector proxies, including
HTTP connectors; connector credentials are removed with the attempt's temporary
configuration. Agent opt-outs and gateway defaults apply to both harnesses.
Container and isolated workers do not receive host custom connectors.

To verify the native Codex proxy path without provider billing, run
`node scripts/orchestration/smoke-codex-worker.cjs --connector` from a development
checkout with Codex and the MCP dependencies installed. This uses a local fake
Responses server and a fixture MCP connector; it does not test a real vendor.

Add `--container --native-auth` to test a container-local installed MCP connector,
including resume, container recreation, steering and cancellation. Add `--native-mcp`
with `--native-auth --connector` to test a Codex-configured MCP connection on the
host or inside the container. Run
`bun scripts/orchestration/smoke-codex-extensions.ts` to verify native MCP discovery,
execution and disabled-tool filtering without any model call.

## Container runtime smoke test

From a development checkout with Docker and Codex installed, run:

```bash
node scripts/orchestration/smoke-codex-worker.cjs --container
```

This creates a temporary plain Debian container, mounts the resolved host Codex runtime read-only, and uses a local fake Responses API. It verifies scoped MCP, native resume, steering and cancellation without provider billing. The temporary container is removed afterward. It does not change a running gateway or installed app.


## Native capability boundaries

The model-running worker uses a private native configuration. Notification programs,
executable hooks, automatic plugin startup, browser/computer tools, image generation,
shell snapshots, native multi-agent and automatic dependency installation remain
disabled there. Enabled extension instructions and MCP capabilities are projected
explicitly into that configuration. Native extension discovery and the MCP sidecar
can read enabled plugins, with executable hooks and notifications disabled before
startup. Unexpected effective capabilities and unhandled approvals fail closed;
ordinary user questions use the task question flow. Explicit shell commands and
coding tools remain available within the authorized worker profile.

For app workers, Docker is the filesystem and process boundary (`externalSandbox`). Workers can edit the app workspace and writable container layer and use network access. Tasks sharing the same app container are not separate security identities. Host-execution workers remain trusted with the host user's authority; a worktree is not an OS sandbox. These controls prevent unintended native integrations, not arbitrary actions by a trusted worker with shell access.

## Verify the native shell integration

With an installed Codex binary, the repository includes a local Responses fixture
that makes the real CLI execute a command, load an explicit startup hook, and
check the selected project directory. No model billing or real provider credential
is needed:

```sh
node scripts/orchestration/smoke-codex-worker.cjs --shell-environment
node scripts/orchestration/smoke-codex-worker.cjs --shell-environment --container
```

The second command requires local Docker and a compatible native runtime. It
creates and removes its own test container and checks that host worker environment
settings are not inherited.

### Completion and native background work

A worker must return a nonempty final report before its task can succeed. An empty or whitespace-only result fails with `WORKER_RESULT_MISSING`; it does not unlock an `after_success` continuation. Existing side effects are retained, so inspect them before retrying.

For Claude Code workers, native `task_started` and `task_notification` events keep background commands and monitors attached to the running gateway task. An interim “waiting” turn does not release the execution slot or close the process. The gateway waits for tracked native tasks to finish and for the worker's subsequent final response. Cancellation, process exit and configured task deadlines still apply. A native completion event alone is not proof that the requested action (such as a merge) succeeded: the worker must inspect and report the outcome. Use gateway cron tools for authorized recurring work rather than promises to wake up after the worker ends.

A persisted `task_request_input` is an intentional pause, not successful completion or a missing-result error. After that native turn ends, the gateway stops the worker's process group (including monitors), releases its execution slot only after cleanup is confirmed, and retains the pending question. Independent tasks may run while it waits. An answer creates the next revision; `after_success` tasks remain blocked until the original assignment actually completes. If an answer or cancellation arrives during cleanup, it is retained without admitting a replacement process before the old one stops. Unconfirmed cleanup requires reconciliation rather than releasing capacity.
