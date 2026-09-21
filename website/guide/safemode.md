# Safemode investigations

`claude-gateway safemode` opens the real Claude Code terminal UI in a private investigation workspace. The gateway continues running. Codex is also supported:

```sh
claude-gateway safemode --name voice-debug --prompt "Inspect gateway session 11111111-2222-4333-8444-555555555555"
claude-gateway safemode --cli codex --name codex-debug --model YOUR_MODEL
claude-gateway safemode --resume voice-debug
```

`--resume` selects a **native Claude Code/Codex session ID or saved name**, not a gateway chat session. Put gateway chat session IDs in the initial prompt, or tell the interactive CLI after it opens. Initial prompts collect matching bounded database evidence; for later chat session IDs, send a fresh prompt through safemode to refresh the snapshot.

## Models and config

Add an optional top-level `safemode` section to the gateway config:

```json
{
  "safemode": {
    "cli": "claude",
    "claude": { "model": "inherit" },
    "codex": { "model": "inherit" },
    "allowedAgentIds": []
  }
}
```

The resolved target config path is saved with the investigation, including through agent takeover. Use an explicit `--config` to change it.

The model selection order is command override, saved investigation selection, safemode config, native CLI default. First launch defaults to Claude Code and `inherit`. Inherit deliberately follows the native CLI's current configuration; it does not pin an unknown concrete model. Choose an explicit model to pin it across resumes. Gateway conversation/worker model settings are independent. A native conversation cannot switch between Claude and Codex.

Native authentication must already be configured. Codex uses its own native provider/login, including ChatGPT and keyring authentication; it does not borrow Claude credentials. Default launches check local native configuration/auth without a model request. Missing login reports `codex login` or `--cli claude`; resumed sessions never switch harnesses. Explicit interactive `--params` is operator-controlled and lets the native CLI validate login itself. Safemode still forwards the selected native provider’s `env_key` and environment-backed headers, resolving a named profile before CLI `-c` overrides. Unrelated gateway, Claude and GitHub credentials are not forwarded. Local readiness does not prove network access or quota. This implementation uses Claude Code's `--safe-mode` / `--restricted` and Codex's `exec resume` / `--ignore-rules`; older CLIs without these flags fail rather than silently removing restrictions. Tested with Claude Code 2.1.274 and Codex 0.154.0. Claude headless inheritance preserves native authentication settings and the user's model setting, without importing permission grants or executable customizations ignored by restricted mode.

## Local controls and takeover

```sh
claude-gateway safemode list --json
claude-gateway safemode status voice-debug --json
claude-gateway safemode send voice-debug --takeover --request-id investigate-1 --prompt "Inspect the latest interruption" --json
claude-gateway safemode status voice-debug --request-id investigate-1 --json
claude-gateway safemode logs voice-debug --json
claude-gateway safemode stop voice-debug
claude-gateway safemode --resume voice-debug --takeover
claude-gateway safemode delete voice-debug
```

`send` starts headless execution in the background; `--wait` runs it in the foreground. One owner is allowed per investigation. Without explicit `--takeover`, an active owner returns `BUSY`. A send can take over an interactive owner; an already running headless request remains busy and must be explicitly stopped first. Takeover announces the stop in the existing terminal, sends graceful termination, waits for exit, and then resumes the same native conversation. Stop requests carry the observed owner token; if ownership changes before the request arrives, the replacement owner refuses it. A timeout does not authorize starting a second owner or killing an unrelated process.

Safemode also checks native ownership outside its own lock: Claude's live session registry and native process evidence, plus Codex writer-lock/rollout descriptors. `list` and `status` include `nativeOwners`, or an explicit ownership-verification error. An existing external owner blocks launch even when no safemode owner is recorded. External processes are never terminated by `--takeover`; close them through their own terminal first.

On Linux, ownership is checked before preparing diagnostics, immediately before launch, and every second while running. If another owner is positively identified, safemode requests termination of **its own child only** and marks its request failed. Different native config homes and unrelated registered sessions are kept separate. Platforms without the required `/proc` evidence are refused rather than treated as free. A same-user native process with protected `/proc` metadata, including a container process, can also prevent verification even when it appears unrelated. Safemode reports the PID and refuses a new launch; it never stops the external process. After a session has started successfully, an inspection failure produces one warning and ownership checks continue without killing the active session. A detected competing owner still stops the safemode-managed child. Monitoring cannot establish exclusive ownership while process metadata is inaccessible.

**External CLI limitation:** Claude Code 2.1.278 permits concurrent `--resume` of the same native session. Safemode cannot make an arbitrary external Claude CLI honor its lock, so the monitor cannot guarantee zero transient overlap or immediate termination if its child ignores the signal. Codex 0.154.0 rejects concurrent writers through its native writer lock; older versions without that behavior are not a basis for an atomic-exclusion guarantee. Strict exclusion across every possible launcher requires a shared native lock respected by those launchers. Safemode's own launches remain serialized by its private ownership lock.

Request IDs prevent duplicate work. Reusing an ID returns its recorded outcome; changing its prompt/model is rejected. After an unexpected crash, a running request's outcome can remain unknown: inspect it before choosing a new ID. Safemode has no internal work queue. The caller/orchestrator owns scheduling, dependencies and retries.

Headless output retains the most recent bytes (up to 5 MiB), so verbose intermediate tool output does not discard the final diagnosis. The logs command returns the latest 64 KiB.

Private state, request receipts and bounded headless output live under `~/.claude-gateway/safemode`. Interactive output remains in the native terminal/history. `delete` removes safemode-owned artifacts, not the native provider's conversation history. If a supervisor crashes, `recover NAME` clears stale ownership only after both recorded processes have exited. It never signals a PID recovered from disk. An unresponsive live owner must be dealt with manually before recovery.

## Agent control

Trusted host operator agents can use `safemode_list`, `safemode_send`, `safemode_status`, `safemode_logs`, and `safemode_stop`. Add their exact agent IDs to `safemode.allowedAgentIds` and restart the gateway to enable access. This grants access to the host user's safemode investigations and diagnostic output; keep the list limited to operator agents. Default is no agent access. App/container agents and ordinary workers cannot invoke these host controls.

For example, to allow only your host operator agent `claude-founder`, merge this into `config.json`:

```json
{
  "safemode": {
    "allowedAgentIds": ["claude-founder"]
  }
}
```

Keep any other existing `safemode` settings. Use the exact agent ID, not its display name or chat session ID. Restart the gateway when it is idle for this change to take effect. An empty or omitted list produces `ACCESS_DENIED` for agent safemode requests, even though the local operator CLI remains available. This permission grants access to investigation contents and controls, not just the list of names.

Create an investigation interactively first. Then an authorized operator agent can send prompts, including through its Telegram channel. Sending/stopping requires an execution-authorized turn; takeover must be explicitly requested. Scoped admission is checked before invoking the local command. Local controls work while the gateway is down; communication through Telegram requires the gateway/channel to be available. Inspect status and logs to retrieve the result; acceptance alone is not completion.

## Evidence and permissions

Each run refreshes bounded redacted config/log/SQLite snapshots, health evidence and startup/build provenance. When a prompt contains session or task IDs, database collection searches agent directories for matching evidence before applying the eight-agent snapshot limit. Unrelated databases are omitted; coverage lists selected and omitted agents with reasons, as well as IDs beyond the ten-target limit. Targets persist when resuming without a new target; supply a new ID in `--prompt` to switch investigations. Without a target, coverage explicitly identifies the general snapshot. Diagnostic paths are absolute so native resume cannot resolve them against an old working directory. Source snapshots come from `0xMaxMa/claude-gateway` at the recorded build revision. Build commit and startup checkout state are separate evidence: moving a checkout after launch does not change the recorded build. Dirty builds, legacy builds, stale startup records and unavailable evidence are explicitly marked uncertain. A release tag is only an inferred reference unless exact build evidence exists. Main is never substituted as the running source.

Safemode never resets the running checkout, executes fetched source, takes its process lease, or writes the live database. Claude headless has read-only file tools confined to the investigation workspace. Codex headless uses its native read-only sandbox and no approvals; external MCP servers, hooks, legacy notification programs (`notify`), plugins and app/browser tools are disabled. Native image generation and automatic skill/dependency installation are also disabled. Native CLI platform sandbox requirements still apply. Interactive changes require native approval. Headless cannot silently escalate to an unrestricted host shell.

Ask for a diagnosis with evidence, hypotheses, proposed repair and regression tests. To file an issue, explicitly request it in the interactive investigation: the CLI should search duplicates, prepare sanitized English content, and use authenticated `gh` with approval. Restricted headless execution supplies a draft when publication is not permitted. Automatic redaction is best effort; inspect content before publishing. Safemode does not automatically merge, deploy, restart the gateway or publish issues merely because diagnostics were collected.

## Native interactive parameters

Use `--params` for native Claude Code or Codex options from your terminal:

```bash
make cli ARGS="safemode --cli codex --params '--dangerously-bypass-approvals-and-sandbox resume 11111111-2222-4333-8444-555555555555'"
make cli ARGS="safemode --resume investigation-name --params '--model gpt-5'"
```

Safemode splits the quoted value into arguments without shell evaluation, variable
expansion or command substitution. Your calling shell and Make still process their
own quoting; do not interpolate untrusted text into a shell command.

Explicit parameters replace the default interactive permission/MCP isolation
options with the native CLI's configuration and your supplied options. Provider
credentials still use the filtered environment. Without `--params`, existing
interactive defaults remain unchanged. Parameters are not saved or reused by
headless requests. `send` and the MCP tools do not accept this option.

Outer `--resume` selects a saved safemode conversation by its native session ID or name. Native `resume UUID`
(Codex) or `--resume UUID` (Claude Code) inside `--params` attaches that exact
native conversation to a new investigation. Combining the two is an error.
If an investigation already owns that native ID, use its outer `--resume`.
A native process already using the conversation must exit before attachment.

Session identity, noninteractive execution, remote endpoints and working-directory
switches are not passthrough options: safemode needs a locally trackable interactive
conversation. Picker/`--last`, continuation and fork modes are unsupported. Use
`--prompt` for initial prompt text. Native flags are validated by the installed CLI;
unsupported flags fail normally rather than being silently ignored.

## One native session, one ID

Safemode uses the Claude Code or Codex session UUID as its only public session ID.
The same UUID works with `--resume`, `status`, `send`, `logs`, `stop`, `recover`
and `delete`. Names are optional aliases, not separate session identities.

Claude Code receives the UUID on its first launch. Codex assigns its own UUID:
until its authoritative session metadata is available, `list` shows
`id: null`, `status: "starting"` and a temporary name you can use to stop it.
Once discovered, safemode publishes the native UUID and keeps the same workspace,
owner lock and control socket. It never guesses the latest global Codex session.

Older investigations are exposed by their native UUID. Idle metadata migrates
automatically; live legacy supervisors keep their files and ownership unchanged
until they exit. Existing workspace directories, diagnostic logs and request
receipts remain in place. Their storage directory names are private implementation
details, not another session ID. Native conversation history is never rewritten.

`make stop` uses the gateway CLI's manager-aware stop operation and no longer
kills processes by command-line pattern. Safemode opened independently in another
terminal remains running when the gateway stops or restarts. Closing that terminal,
stopping its enclosing service/container, or rebooting the host still stops it.

## Rename a safemode conversation

```bash
make cli ARGS="safemode rename 11111111-2222-4333-8444-555555555555 gateway-debug"
make cli ARGS="safemode --resume gateway-debug"
```

The first argument accepts the native session ID or the current name. Names
contain 1–64 letters, digits, dots, underscores or hyphens and must be unique.
Renaming works while the native CLI is running; it does not stop or restart it,
change its native ID, or move its workspace/history. The old name stops resolving,
while the native ID continues to work. Rename changes the safemode alias, not the
native CLI's own conversation title.

If a rename process is interrupted, close the native conversation and use
`safemode recover ID` to clear a stale rename claim. Recovery refuses while
either the conversation owner or rename owner is still alive.

## Interpreting subprocess diagnostics

Claude Code subprocess exit records include the gateway response ID (agent turns), task/attempt IDs (workers), native message ID when available, model, turn outcome and exit reason. A completed turn followed by cleanup can exit with code 143; this is distinct from `unexpected_exit` without a terminal result. Cancellation, timeout and shutdown are recorded separately. Failed turns retain their failure code when available.

CLI stderr remains visible and correlated with these records. A model-name warning does not establish provider rejection: check the terminal `inferenceOutcome` and the recorded error. Success means the CLI reported a successful result, not that every earlier request succeeded. Missing terminal evidence remains unconfirmed.

## Terminal appearance

Interactive safemode preserves the caller's terminal identification, tmux and color preferences rather than choosing a separate theme. Reopen the CLI after upgrading for environment changes to take effect; restarting the gateway does not change an already running safemode CLI.


When tmux reports a light background through OSC 11 while the attached terminal is dark, Codex can draw pale prompt boxes. Preserving environment variables alone cannot correct a wrong terminal color response. This can occur with differing client themes attached to a shared tmux session. Check the pane/client theme before treating it as a safemode rendering problem.

If you deliberately want a dark palette for the current pane, set it explicitly from a shell in that pane:

```sh
tmux select-pane -t "$TMUX_PANE" -P 'fg=#d4d4d4,bg=#171717'
```

Exit the native CLI only when it is idle, then reopen the same safemode session with `--resume` so it queries the new colors. The setting affects that pane, not all tmux sessions; safemode does not force a palette automatically. To restore inherited pane styling, use `tmux select-pane -t "$TMUX_PANE" -P default`. This is a local terminal adjustment, not a provider or authentication change.

## Troubleshooting

| Symptom | Meaning and next step |
| --- | --- |
| Agent receives `ACCESS_DENIED` | Check the exact agent ID in top-level `safemode.allowedAgentIds`, then restart the gateway when idle. App/container agents and ordinary workers remain denied. Sending or stopping also needs an execution-authorized turn. |
| `BUSY` | An investigation already has an owner. Inspect `status`; use explicit `--takeover` only when you intend to stop its current interactive owner. Stop an active headless request first. |
| Native session already belongs to an investigation | Use `safemode --resume NATIVE_ID`; do not attach it again through native `resume` parameters. |
| Native ownership cannot be verified before launch | Inspect the reported PID and OS process visibility. Safemode refuses a new launch without sufficient evidence. `recover` does not bypass a live owner. |
| Ownership inspection warning during an active session | The session stays running and checks continue. This warning alone does not mean another owner exists. |
| Gateway logs mention a session but its database is absent | Reopen with `--prompt "Inspect gateway session UUID"` or send a new safemode prompt containing that ID. Read `diagnostics/coverage.json` for selected/omitted agents and limits. Typing an ID inside the native UI alone does not refresh gateway snapshots. |
| `diagnostics/...` is missing after native resume | Use the absolute diagnostic paths in the latest safemode prompt. Native history may contain paths from an earlier working directory or snapshot. |
| CLI reports an unfamiliar model name | Check the correlated terminal request outcome and provider error. A warning accompanied by a successful result is different from a rejected request. |
| Colors differ from the normal terminal | Close and reopen safemode after upgrading so it inherits current terminal/color settings. Gateway restart alone does not update an existing native CLI. Compare in the same terminal and tmux pane; safemode does not override a native theme or repair terminal palette settings. |
| `delete` refuses an investigation | Stop its owner first. Deletion removes safemode state and snapshots, not native CLI conversation history. There is no `clear all` command. |

## Snapshot coverage

Snapshots are evidence collected at launch or `send` time, not a live mirror. Read `coverage.json` before drawing conclusions:

- Up to ten unique target UUIDs and eight matching agents. Agent directory order does not exclude a matching agent merely because eight unrelated agents precede it.
- Each database snapshot is capped at 1 MiB, 50 recent rows per table and 8,192 characters per text field. Tables without session columns can include recent rows unrelated to the target.
- Logs contain the eight most recently modified streams, with at most 128 KiB from each tail. Log selection remains time-based, so old target events may be absent.
- Five previous diagnostic snapshots are retained. New snapshots and saved target selection do not modify live gateway databases or native conversation history.
- A session ID supplied in a new safemode prompt replaces the saved target selection. A resume without new IDs retains it. An untargeted first launch is explicitly marked as a general snapshot.

Replace the example UUIDs with your gateway chat session ID when selecting evidence, and with your **native CLI session ID** when resuming a safemode conversation. They identify different things.
