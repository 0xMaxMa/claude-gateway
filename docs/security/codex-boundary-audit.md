# Codex execution boundary audit

Reviewed for PR #520, 2026-09-20. Native verification used the installed Codex CLI and a local mock Responses API, without real provider credentials or billing.

## Fixes

- Restricted safemode explicitly sets `notify=[]`. Disabling `features.hooks` alone does not disable legacy notification programs. Before the fix, a harmless notification fixture wrote outside the read-only investigation workspace; afterward fresh and resumed turns completed without executing it.
- Workers and restricted safemode share startup overrides disabling hooks, plugins, apps, browser/computer tools, native multi-agent, shell snapshots, image generation, automatic skill MCP installation and workspace dependency setup. These overrides apply before thread creation, including container launches. Gateway tools and explicit coding commands remain available according to the task profile.
- Worker effective configuration rejects enabled native side channels, executable hooks/notify, unexpected project layers, mismatched MCP commands/arguments/environment, and provider drift before starting a model thread.
- Deliberate interactive safemode `--params` retains operator-selected native options. It is not a restricted unattended execution mode and cannot be supplied through MCP or headless send.

## Checked boundaries

| Surface | Enforcement / evidence |
| --- | --- |
| App vs host execution | App workers require container binding; host execution is refused. Failed container startup does not retry on host. |
| Docker privileges | Admission rejects privileged containers, host/shared network namespaces, host PID/IPC namespaces, extra capabilities, missing capability drop/no-new-privileges, devices and unapproved host mounts. |
| Filesystem mounts | Workspace/media belong to that app. Runtime mounts are read-only with allowlisted sources, selected runtime fingerprint and native executable hash checks. Docker/containerd sockets and arbitrary host mounts are rejected. Personal Codex home is not mounted. |
| Provider credentials | Selected native API-key/provider settings use the worker environment. Native ChatGPT access tokens use private app-server stdio and ephemeral auth storage; refresh requests are handled by host Codex. Native refresh tokens, keyring storage and the personal Codex home are never copied or mounted. Credentials are not placed in command arguments. |
| Native configuration | Private per-attempt Codex home plus startup policy. Effective provider/MCP/config inspection precedes thread start. Only prior native session data is copied on resume. |
| Gateway MCP | App workers receive the container tool inventory and a scoped revocable task ticket. Host shell/admin, task spawning, host media/browser and unauthorized file operations are rejected by the bridge. |
| Runtime approvals | Unexpected native server requests for interaction/approval return an error and stop the worker; no automatic approval handler. |
| Resume / cancellation | Native host and container smokes cover MCP, exact resume, container recreation recovery, mid-turn amendments and process cancellation. |
| Native side effects | Native safemode smoke verifies completion without the inherited notification program, including resume. Tests reject unexpected native features before thread creation. |

## Intentional authority and limits

- A coding worker can run shell commands and edit code. A host-execution worker is trusted with the gateway OS user's authority. A worktree is not an OS user or security boundary. `workspace-write` primarily constrains writes; it is not a promise that all other host files are unreadable.
- App workers use Codex `externalSandbox`: Docker supplies isolation, not a second Codex filesystem sandbox. They can write the app workspace and writable container layer. Jobs sharing a container/user are not isolated from one another.
- Network is enabled for app tasks. Container isolation alone is not an egress firewall: reachable app services or host/LAN endpoints still require authentication and network policy. This change does not implement per-task containers or outbound filtering.
- A credential needed by the native process is available to that process. Shell access under the same identity is not a vault boundary. The changes prevent accidental inheritance; they do not make a malicious unrestricted worker unable to inspect its own process environment.
- Operator-approved custom connectors and explicit interactive `--params` are trusted execution. Disabling built-in browser/image tools does not prevent an authorized shell from making HTTP calls or running installed software.
- Passing regression tests is not a proof against container/kernel vulnerabilities or all future Codex features. New native CLI versions require renewed capability and configuration checks.

## Repeatable verification

```bash
npm run build
node scripts/orchestration/smoke-safemode-codex.cjs
node scripts/orchestration/smoke-codex-worker.cjs --native-auth
node scripts/orchestration/smoke-codex-worker.cjs --container --native-auth
```

Native smokes are opt-in and use temporary fixture state; the container smoke needs local Docker. Unit coverage includes `safemode/native`, `session/codex-process`, `session/codex-container-runtime`, `orchestration/container-boundary` and `orchestration/container-preflight`.

Official references: [hooks](https://developers.openai.com/codex/hooks), [configuration](https://developers.openai.com/codex/config-reference), [security](https://developers.openai.com/codex/security). Runtime findings above were also checked against the installed native CLI.
