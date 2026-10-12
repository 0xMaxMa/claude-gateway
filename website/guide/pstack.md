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

An agent that is not set up loads **nothing** from pstack, even when the plugin is enabled globally: every host worker gets `enabledPlugins["pstack@pstack-claude"]` in its `--settings` overlay, `false` unless the agent has an `agents[].pstack` block. Claude Code merges that key over your own settings, so other plugins load as before. Workers of a set-up agent get the plugin and the agent's own model sheet.

Set it up in a direct message with the bot:

| Message | Effect |
| --- | --- |
| `/pstack-setup on` | Set the agent up with every role at its skill default |
| `/pstack-setup why investigators: gpt-6-sol[1m]` | Set one role |
| `/pstack-setup interrogate reviewers: claude-opus-5-5 @xhigh, gpt-6-astra[1m]`<br>`default effort: high` | Several `pstack-models.md` lines in one message |
| `/pstack-setup bug-fix: default` | Drop an override, like deleting the line |
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

Until subagents run as gateway tasks, Claude Code's own `Agent` tool takes only model families, not IDs, so a skill falls back to its default model for a subagent and says so.
