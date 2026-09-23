# Configuration

The default configuration is `~/.claude-gateway/config.json`. Set `GATEWAY_CONFIG` to use a different file. The gateway loads `~/.claude-gateway/.env` on startup; agent-specific environment files are configured through `agents[].env`.

## Start from generated configuration

First boot creates a valid empty-agent configuration. Use the agent wizard to add required workspace and connection fields. The repository's [config.template.json](https://github.com/0xMaxMa/claude-gateway/blob/b917843/config.template.json) is a starting template; it includes migration metadata and placeholder credentials, so do not overwrite a working configuration with it blindly.

The following is a **partial configuration**. Merge the shown fields into the existing `gateway` object while retaining your agents and keys:

```json
{
  "gateway": {
    "bind": "127.0.0.1",
    "timezone": "UTC",
    "headless": true,
    "history": {
      "retentionDays": 60,
      "cleanupHour": 0,
      "cleanupTimezone": "UTC"
    }
  }
}
```

Website checks validate JSON syntax only; they do not compare fields or types against the repository template or config schema. The gateway loader performs runtime configuration validation when loading your configuration.

## Settings by purpose

| Setting | Purpose |
| --- | --- |
| `gateway.bind` / `GATEWAY_BIND` | Listening interface; environment override takes precedence |
| `PORT` | Listening port, default `10850` |
| `gateway.publicUrl` | Externally reachable origin for share links, image references, and `/cli` |
| `gateway.api.keys` | API credentials and agent/write/admin scope |
| `gateway.models` | Fallback model catalog |
| `agents[].workspace` | Agent source workspace |
| `gateway.workers.environment` / `agents[].workers.environment` | Explicit host worker environment; agent values override by key |
| `gateway.workers.containerEnvironment` / `agents[].workers.containerEnvironment` | Separate app-worker environment; does not inherit host settings |
| `agents[].orchestration.tasks.projectRoot` | Default worker project directory; preserves the Agent identity workspace |
| `agents[].session` | Legacy idle timeout and concurrency |
| `gateway.history` / `agents[].history` | Chat/media retention |
| `gateway.memory`, `gateway.knowledge`, `gateway.dreaming` | Memory budget, indexing, consolidation |
| `gateway.sessionCompaction` / `agents[].sessionCompaction` | Optional nightly native session compaction; see [memory settings](./memory-settings.md#nightly-session-compaction) |
| `gateway.skillLearning` | Automatic skill review and limits |

Fresh configurations and the server fallback bind to `127.0.0.1`. Migration preserves older externally reachable deployments by pinning `0.0.0.0` when needed; check your actual configuration after upgrading. A public URL does not itself configure a reverse proxy or make a loopback server reachable.

## Credentials and scope

Environment placeholders use `${VARIABLE_NAME}` syntax. Keep actual values in the appropriate environment file. Admin access requires `admin: true`; `agents: "*"` alone is not an admin grant. Use a scoped key for integrations and retain an admin key for gateway management.

Run `claude-gateway doctor` after changes, then verify the affected capability. Config migration adds new defaults and backs up the previous configuration; preserve those backups when upgrading. Some configuration changes hot-reload, while operations that replace installed code require a restart.

Continue with [gateway settings](./gateway-settings.md), [memory and knowledge settings](./memory-settings.md), [orchestration settings](./orchestration-settings.md), [voice configuration](../guide/voice.md), or [Jev evaluations](../guide/jev.md).

## Enable orchestration

`gateway.orchestration` is a single boolean, applying to every agent and channel. Per-agent `orchestration` holds tuning, not a second enable switch. Voice settings belong in `agents[].voice`. Enabling orchestration normalizes and persists `gateway.headless: true`. Linux is required for its process supervisor.

```json
{
  "gateway": { "orchestration": true, "headless": true }
}
```

For a new deployment, create the agent first using the wizard, then merge this block into the generated configuration. Use [voice setup](../guide/voice.md) to configure speech separately. `gateway.orchestration: false` retains the legacy conversation path and hides orchestration-only commands.

## Applying changes

Saving JSON, loading valid configuration, and applying it to a running component are separate operations. A saved value is not proof that an existing model process, channel connection, or scheduler has adopted it. See [Applying configuration changes](./configuration-changes.md) for the lifecycle, environment precedence, and verification steps.

- Live settings affect subsequent operations in the running gateway.
- Process settings take effect when the affected process is next created; they cannot change the environment or tool inventory of an existing CLI process.
- Connection and scheduling settings need the affected component to reconnect or reschedule.
- Startup settings and installed code require a gateway restart. Check active conversations and tasks first.

Voice settings changes apply to new voice connections and later replies; reconnect a live voice session to use the new settings consistently.

Do not copy an entire example over an existing config: this can discard agent entries, credentials, and unrelated settings. The API offers scoped updates to individual resources.

See [worker command environment](../guide/worker-harnesses.md#worker-command-environment) for startup-hook examples, native shell differences, reserved variables, and container behavior.


### Computer Use via Jev

`gateway.jev.features.computerTasks.enabled` controls Gateway-managed desktop
execution (defaults to enabled when Jev is enabled). Agent Jev allowlists and
connector enablement still apply. Set it to `false` to disable new desktop work;
active runs check authorization before further actions. The shared
`gateway.jev.thinking` provides text and independent goal verification.
Pairing credentials belong in connector secrets, never in prompts or agent
containers. See [Computer Use connectors](../guide/jev.md#computer-use-connectors)
for discovery, scoped targets, local consent and restart behavior.
