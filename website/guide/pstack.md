# pstack

[pstack-claude](https://github.com/michael-denyer/pstack-claude) is a Claude Code plugin (`pstack@pstack-claude`): skills such as `how`, `why`, `interrogate` and `arena`, effort agents, and a SessionStart hook. Through the gateway it behaves the way it does in the Claude Code CLI. The gateway only decides **which agents** load it and with **which models per role**.

## Install once, through Claude Code

On the gateway host, as the user the gateway runs as:

```text
/plugin marketplace add michael-denyer/pstack-claude
/plugin install pstack@pstack-claude
```

Update it with `/plugin update` and check the version with `/plugin`. The gateway has no install command, keeps no copy and pins no version: every agent uses the one install Claude Code manages. It only reads `installPath` from `~/.claude/plugins/installed_plugins.json` (or `$CLAUDE_CONFIG_DIR`).

Running Claude Code directly on the host is unaffected: the plugin behaves as any installed plugin does there.

## Set up an agent

An agent that is not set up loads **nothing** from pstack, even when the plugin is enabled globally: every host worker gets `enabledPlugins["pstack@pstack-claude"]` in its `--settings` overlay, `false` unless the agent has an `agents[].pstack` block. A session of an agent without orchestration gets the same `false` key; it is merged into a `--settings` you set in `claude.extraFlags` rather than added beside it. Claude Code merges that key over your own settings, so other plugins load as before. Claude workers of a set-up agent get the plugin and the agent's own model sheet. Codex workers never get pstack: no plugin, no sheet and no pstack skills in their catalog. The agent's own skill catalog lists pstack's skills only once it is set up, and `/pstack:<skill>` sent to an agent that is not set up is answered with a pointer to `/pstack-setup` instead of reaching the agent. On a set-up agent, `/pstack:<skill>` for a skill that is not user-invocable (the `principle-*` skills) is answered at once that it is not a command, as in Claude Code; workers load those skills by themselves. The gate decides what Claude Code loads, not what a host worker can read: the plugin's files stay on the host's disk. The gateway's own one-shot `claude -p` helpers (session titles, summaries, skill reviews) always run with pstack off.

Set it up in a direct message with the bot:

| Message | Effect |
| --- | --- |
| `/pstack-setup on` | Set the agent up with every role at its skill default |
| `/pstack-setup why investigators: gpt-6-sol[1m]` | Set one role |
| `/pstack-setup interrogate reviewers: claude-opus-5-5 @xhigh, gpt-6-astra[1m]`<br>`default effort: high` | Several `pstack-models.md` lines in one message |
| `/pstack-setup bug-fix: default` | Drop an override, like deleting the line |
| `/pstack-setup interrogate reviewers += gpt-6-sol[1m] @high` | Add one entry to a panel role (an unset panel starts from its skill default; one model per line) |
| `/pstack-setup interrogate reviewers -= claude-haiku-5-5` | Remove a model's entries from a panel role (the last one cannot be removed; use `<role>: default`) |
| `/pstack-setup off` | Remove pstack from the agent |

`/pstack-setup` alone shows the agent's state, its current sheet and the model IDs to choose from. Arguments are lines of pstack's own `pstack-models.md`. Changes apply to the agent's next worker.

Or through the API or CLI (an admin key may change any agent, a write key the agents it can access):

```bash
claude-gateway pstack enable alfred --roles '{"bug-fix":"claude-fable-5-1 @xhigh"}' --defaultEffort session
claude-gateway pstack disable alfred
```

See [`PUT /api/v1/agents/:agentId/pstack`](../api/agents.md#put-apiv1agentsagentidpstack).

## Configuration

`agents[].pstack` mirrors `pstack-models.md`, with **full model IDs** instead of slugs:

```json
{
  "id": "alfred",
  "pstack": {
    "defaultEffort": "session",
    "roles": {
      "bug-fix": "claude-fable-5-1 @xhigh",
      "how explorer": "claude-sonnet-5-5 @medium",
      "why investigators": "gpt-6-sol[1m]",
      "interrogate reviewers": "claude-opus-5-5 @xhigh, gpt-6-astra[1m] @high, claude-sonnet-5-5, claude-haiku-5-5"
    }
  }
}
```

| Field | Values | Default |
| --- | --- | --- |
| `roles` | pstack role -> `"<model-id>[ @<level>]"`; a comma-separated list for the panel roles (`arena runners`, `arena cross-judge pool`, `architect runners`, `interrogate reviewers`), one subagent per entry | every role uses its skill default |
| `defaultEffort` | `session` (the parent's effort) or `low`, `medium`, `high`, `xhigh`, `max` | `session` |

Model values are IDs from `/models`. Aliases such as `opus` or `gpt6sol` are refused with `MODEL_ALIAS_NOT_ALLOWED` and the ID to use, so a role never changes model when an alias moves; `inherit-parent` and `auto` are pstack keywords (run on the parent's model) and are accepted. Saving checks every model, level and role against the live catalog and the installed plugin (`UNKNOWN_MODEL`, `INVALID_EFFORT`, `UNKNOWN_PSTACK_ROLE`, `PSTACK_NOT_INSTALLED`); any other field is refused.

The worker sees the agent's sheet in its context instead of `~/.claude/pstack-models.md`. Every role is listed, with pstack's default slugs written as IDs (`opus` = `claude-opus-5-5`, `fable` = `claude-fable-5-1`, `sonnet` = `claude-sonnet-5-5`, `haiku` = `claude-haiku-5-5`). The gateway never writes the global sheet.

The plugin's SessionStart hook reads `session hook: on|off` only from the global `~/.claude/pstack-models.md`, so that line applies to every set-up agent alike and has no per-agent setting.

## Panels

A panel role (`arena runners`, `arena cross-judge pool`, `architect runners`, `interrogate reviewers`) is a list, exactly as in pstack: one subagent per entry (`+=` and `-=` edit panel roles only; any other role takes exactly one model, and a list there is refused), so the list length is the number of reviewers, and each entry may carry its own `@level`. Mix providers freely, e.g. `claude-opus-5-5 @xhigh, gpt-6-sol[1m], claude-sonnet-5-5`. The skill combines the results itself (in `interrogate` the parent is the lead), and a failed reviewer is reported to the skill like any subagent result. There is no budget: effort and list length are the only controls, and the provider's quota is the ceiling.

While a panel runs, Telegram's status message gains one line per task, prefixed with that task's title and counting its direct subagents, such as `interrogate: 2/4 · ✅ Opus 5.5 · ⏳ GPT 6 Sol · ❌ Haiku 5.5 (worker timeout)`. Subagents never message the chat; the answer arrives once, from the task that ran the skill, and that task's `task_status` lists each subagent's model, harness, effort, state and duration. The dashboard's Tasks view shows subagents under their parent.

## Subagents

A set-up agent's Claude workers that load the plugin do not use Claude Code's own `Agent` tool (it is disabled for them). pstack's fan-out goes through three worker tools with the same arguments instead, so every subagent is a gateway task that can run on another provider. `/tasks`, `/stop` and the task list API show only the task that ran the skill; its `task_status` lists the subagents, and stopping it stops them:

| Tool | Does |
| --- | --- |
| `subagent_spawn` | `description`, `prompt`, `subagent_type`, `model`, `readonly`, `run_in_background` — like `Agent`. `model` is a model ID from the sheet (omitted, `inherit-parent` or `auto` = the parent's model); a `pstack:effort-<level>` agent sets the subagent's effort, otherwise it inherits the parent's. In the foreground it waits and returns the result; in the background it returns a `task_id` |
| `subagent_wait` | Waits for the listed subagents and returns each result, failure, or question |
| `subagent_cancel` | Cancels the caller's own subagents |

- Subagents nest at most three levels below the worker; the third level gets no subagent tools and works inline.
- Subagents use the usual per-agent and per-conversation task limits, except that a subagent's own waiting ancestors are not counted against it, so a chain can always continue while siblings queue.
- When a task ends, is being cancelled, fails, or needs reconciliation, its unfinished subagents are cancelled with it, and a read-only subagent's own subagents are read-only too.
- A subagent's question (`task_request_input`) is returned to its parent by `subagent_wait`; it is never asked in the chat.
- A subagent's prompt is its whole assignment, as with Claude Code's own subagents: it does not see the user's request or the conversation, only what its parent wrote.
- Subagents report to their parent, never to the chat. The agent's task index lists the root task only; `task_status` with its `task_id` lists the subagents.
- A GPT subagent runs on Codex without the plugin: it gets the agent definition, the prompt and the plugin's path to read files the prompt names. `readonly` is an instruction there, as in pstack's own Codex mapping; a read-only Claude subagent also gets read tools only. Either way a read-only subagent, including one that inherited readonly, is told so (right after the agent definition, which may claim the full tool set), and its gateway tools exclude those that change something (cron changes, memory writes, file sharing, narration, image/video generation and the browser); the gateway refuses them if called.
- `isolation: "worktree"` runs on the host as usual and answers `isolation: "ignored"`. Resuming an earlier subagent is not supported; pstack spawns fresh subagents.
