# Applying configuration changes

Use this page together with the [configuration reference](./configuration.md). Examples elsewhere in the docs are partial objects: merge them into the existing configuration rather than replacing the file and losing agents or credentials.

## Saved configuration and running configuration

The gateway watches its selected `config.json`, waits for writes to settle, loads and validates the file, then dispatches changes to runtime components. This is asynchronous. A JSON syntax or top-level validation error retains the preceding configuration and logs `Config reload failed, keeping current config`. Agent-specific validation failures are reported separately; check for `Agent skipped during config reload` as well.

The watcher detecting a field does not by itself update the consumer of that field. Likewise, `doctor` checks local configuration and prerequisites; a successful result does not prove that a running worker has adopted a new setting. Verify the affected feature after editing it.

## When a change takes effect

| Lifecycle | What it means | How to verify |
| --- | --- | --- |
| Live | Subsequent operations read the new value without restarting the gateway | Repeat the operation that uses the setting |
| Next process | Newly created model or worker processes receive the setting; an existing process retains its startup configuration | Inspect a newly started turn or worker, including its model and harness |
| Component reconfiguration | A receiver, connection, timer, or manager must be updated or replaced | Check connection status or the next scheduled run, not only the saved JSON |
| Gateway restart | The running process cannot adopt the change through its reload path | Wait for active work to finish, restart, then verify startup and the affected feature |

These are lifecycle categories, not a promise that every configuration field supports hot reload. In particular, do not infer support for a whole block from support for one field inside it. File edits and API operations can also have different runtime effects: an API endpoint may explicitly reconnect a component while a file edit only updates its persisted settings.

### File-reload behavior

| Configuration | Behavior |
| --- | --- |
| `gateway.jev`, `agents[].jev` | New evaluations capture current provider/model/limits. Global disablement and access revocation are checked before dispatch and return; key files rotate without restart. Browser binding changes/revocation are checked live; controller credentials rotate on new connections. Installed Logic code updates need restart. Existing process tool inventories may require a new process to expose a newly enabled tool |
| `gateway.logs` | Logging policy is reapplied without restarting the gateway. Retention and rotation run on their respective sweeps/writes, not all at save time |
| `gateway.headless` | Applies to later process creation; existing session processes keep their execution mode |
| `agents[].claude.model`, `agents[].claude.extraFlags` | Updates the agent defaults for subsequent process creation; does not rewrite an already running CLI's arguments |
| `gateway.customConnectors`, `gateway.connectorsDefaultEnabled`, `agents[].connectors` | Later session spawns use the new connector settings; an existing MCP process is not automatically replaced by a file edit |
| `agents[].voice` | Refreshes agent voice settings. Reconnect active voice connections when changing their model or transport |
| Telegram / Discord bot tokens | Adding, removing, or replacing a token starts or stops the corresponding receiver. Other channel fields follow component reconfiguration |
| New agent entries | The gateway attempts to start valid new agents dynamically; check the startup result and channel readiness |
| `safemode.allowedAgentIds` | Each privileged call checks the current allowlist, including calls through an existing ticket. New MCP processes expose safemode schemas only to allowlisted host agents |
| `gateway.api.keys` | API authentication reads the updated key list. Changing keys invalidates outstanding PTY/voice tickets and closes those authenticated sockets; clients must authenticate again |
| `gateway.models` | The model catalog and subsequent model selection read the new list |
| `gateway.workers`, `agents[].workers` | Future worker launches use the new harness/environment policy. Existing native processes retain their launch settings |
| `gateway.processLimits` | Admission limits update without killing existing processes. Lowering limits below current usage blocks new admissions until leases drain |
| `agents[].session` | Idle timeout and concurrency checks read the current settings |
| `agents[].heartbeat`, `agents[].allow_tools`, agent display metadata | Subsequent checks and display reads use the new values. An existing issued tool ticket retains its scoped permissions except for the additional live safemode authorization check |
| Other channel settings | The affected channel component refreshes. Telegram/Discord replacement waits for the preceding receiver to stop; unrelated LINE/Slack/WhatsApp Cloud credentials are not rebuilt |
| `gateway.publicUrl`, `gateway.oauthReturnUrl` | Newly generated share links and OAuth completion redirects use the current value. Existing links and reverse proxy configuration are unchanged |
| History cleanup, skill learning, dreaming, session compaction, shared reflection, and `gateway.timezone` | Affected managers/timers refresh. An in-flight dreaming/reflection run retains its resolved configuration; skill-learning changes wait for active reviews to finish |
| Memory and knowledge policies | Refresh generated context for future use without interrupting busy model processes. Storage identity exceptions below remain restart-required |
| App housekeeping, backup and restore policies | Future policy reads use the new values, and backup cleanup is rescheduled |
| Agent removal | Deferred while the agent has active or pending work. Runtime removal stops its receivers and timers without deleting history or workspace files |

### Settings that remain restart-required

Listener/bind settings, storage and workspace identity, log-directory location, agent type/container identity, the agent environment-file path, shared knowledge root/project, and archive tokenizer are not silently moved or recreated by hot reload. Unrecognized changed fields are reported as restart-required rather than ignored. The deprecated `claude.dangerouslySkipPermissions` setting remains ignored.

A restart does not migrate storage or regenerate installed container mounts. Use the appropriate install/recreate procedure when changing container runtime files; see [worker harnesses](../guide/worker-harnesses.md).

### Running work and verification

- A model process keeps its existing environment, tool schemas, and CLI arguments. New schema visibility takes effect on the next process launch; safemode access is additionally checked live on every call.
- A lowered admission limit drains naturally. It does not cancel admitted work to make the displayed count immediately match the new limit.
- Channel reconnection can briefly interrupt receipt of new channel events. It does not replace an unrelated worker process.
- Schedule changes do not run the scheduled job immediately. Check the next timer/run in the configured timezone.
- `Configuration value applied` records the field and lifecycle, without its secret value. Component failures are logged separately as configuration refresh/application failures; inspect these before concluding that a change succeeded.
- API operations can update a runner before the file watcher observes the saved file. Do not use the presence or absence of a watcher log as the sole evidence that an API update worked.

## Environment files and precedence

`${VARIABLE_NAME}` placeholders in JSON are resolved from the gateway process environment. Keep credentials out of examples, screenshots, and issue reports.

| Source | Reload behavior |
| --- | --- |
| Environment inherited from the shell or service | Remains part of the running process. Update the service/shell environment and restart to replace it |
| `~/.claude-gateway/.env` | Loaded at startup; editing it alone does not refresh the running gateway |
| `agents/<id>/.env` beside the selected config file | Read before configuration reload. Values previously injected from that same file can refresh; an inherited variable takes precedence |
| `agents[].env` | Agent environment-file setting; do not assume editing this path or file changes existing subprocess environments |
| Native Claude Code / Codex login | Managed by the native CLI. Gateway JSON reload is not a login or credential migration |

The config watcher watches `config.json`, not every environment file. After changing an agent environment file, trigger a config-file reload or restart when idle. Removing a variable from an environment file is not a reliable way to remove it from an already running process. Use distinct variable names for different agents to avoid unintended precedence between their files.

## Verify a configuration change

1. Confirm which file the running gateway uses. `GATEWAY_CONFIG` selects an alternative to `~/.claude-gateway/config.json`; changing it in another terminal does not change a running service.
2. Preserve a private backup and edit only the intended fields. Retain `${VARIABLE_NAME}` placeholders and unrelated settings.
3. Run `claude-gateway doctor` and inspect `claude-gateway gateway logs` for validation failures, skipped agents, startup failures, and restart requirements.
4. Exercise the affected feature. For a process setting, inspect a new process; for permissions, test the protected operation; for schedules, inspect the next run. A past successful or rejected request is historical evidence.
5. If a restart is required, check conversations and `/tasks` first. Restart when no work is active, then repeat the verification. Do not stop independent safemode investigations merely to apply gateway configuration.

If validation fails, restore the intended valid fields and check the next reload result. Avoid sharing complete configuration dumps: they can contain expanded credentials even when the file originally used placeholders.

### Removing and re-adding an agent

Removal waits until the agent is idle. If the same agent is added back while its old runner is stopping, the gateway waits for that stop to finish and starts one fresh runner from the latest configuration. A later removal cancels that replacement; shutdown does not start replacement runners.

If a hot-added agent cannot start (for example, its workspace is not writable), the failure is logged and retried by the five-second lifecycle sweep rather than an immediate loop. Removing the agent cancels pending retries; a retry uses the latest configuration.
