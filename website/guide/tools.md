# Tools and skills

MCP tools let an agent act through gateway integrations. Skills are Markdown instructions that teach an agent how to carry out a workflow with those tools.

## Verify tools are available

Bun runs `mcp/server.ts`; its dependencies must be installed. After installation, ask an agent to list its available tools and try one read-only operation, such as listing cron jobs. Check the result rather than treating an announced intention as execution.

If tools are unavailable, check `bun --version`, MCP dependency installation, and the agent logs. In a source checkout, `make mcp-install` installs the MCP dependencies.

## Add a skill

Create `skills/review-notes/SKILL.md` inside the agent workspace:

```markdown
---
name: review-notes
description: Review project notes and identify unanswered questions.
---
Read the relevant notes before summarizing.
Separate confirmed decisions from unanswered questions.
Link each finding to its source file.
```

Skills hot-reload. Ask the agent to review a small note and verify that its answer cites the file. The discovery locations and precedence are described below.

## Automatic skill learning

`gateway.skillLearning` controls background review of substantive work. It can create or update automatically learned skills, with daily and total limits and an audit in `SKILLS_LEARNED.md`. The provenance guard preserves human-authored skills. Review the audit when evaluating what the agent learned.

Connector availability and agent tool permissions also affect what a session can do. See [configuration](../reference/configuration.md) and the [MCP server implementation](https://github.com/0xMaxMa/claude-gateway/blob/b917843/mcp/server.ts).

## Skill discovery and precedence

The gateway discovers a skill as a directory containing `SKILL.md`. Hidden directories and `node_modules` are skipped. Keep supporting scripts and examples alongside the instruction file, and refer to them from the skill rather than putting a large manual in its description.

| Location | Registry name | Intended use |
| --- | --- | --- |
| `<workspace>/skills/<name>/SKILL.md` | `<name>` | Workflows specific to one agent |
| `mcp/tools/<module>/skills/<name>/SKILL.md` | `<module>:<name>` | Instructions shipped with an MCP module |
| `~/.claude-gateway/shared-skills/<name>/SKILL.md` | `<name>` | Reusable instructions shared across agents |

Loading proceeds from shared to module to workspace, so a workspace entry overrides an existing registry key. Module prefixes normally prevent collisions with plain workspace/shared names. The generated menu lists user-invocable skills grouped by source. Invoke a workspace skill with `/review-notes path/to/notes.md`, or a module skill with `/<module>:<name> [arguments]`.

Shared and module instructions are also synchronized into `~/.claude/skills/` for Claude's personal skill discovery. `.shared` and `.module` marker files identify managed copies; removed source skills cause their marked copies to be cleaned up. Edit the source under `shared-skills` or the module, because later synchronization can replace edits to a managed copy.

Source: [skill loader](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/skills/loader.ts), [synchronization](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/skills/sync.ts), and [startup/watch wiring](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/index.ts).

## Learning controls and review flow

Learning is enabled in `auto` mode by default. A completed session qualifies for review when it reaches the tool-call threshold, fires recovery, or contains a detected user correction, subject to the daily review budget. A qualifying session does not guarantee a useful skill will be written: the reviewer and writer still evaluate the proposal.

| Setting | Built-in default | Effect |
| --- | --- | --- |
| `minToolCalls` | `5` | Tool-call trigger threshold |
| `maxReviewsPerDay` | `20` | Daily background review ceiling |
| `reviewModel` | `claude-haiku-4-5-20251001` | Background review model |
| `maxAutoSkills` | `50` | Learned-skill capacity |
| `maxAgeDays` / `minUsesToKeep` | `30` / `2` | Curator age/use policy |
| `pruneHour` | `3` | Daily curator hour |
| `notify` | `true` | Learning notifications |

Per-agent `skillLearning` values override `gateway.skillLearning`, then built-in defaults apply. The pruning timezone resolves through agent override, gateway skill-learning override, `gateway.timezone`, then UTC; invalid timezone values fall through to the next level.

Choose `mode: "propose"` to queue candidate instructions in `skills/.pending/` for review before making them live. In `auto` mode, inspect the live skill and `SKILLS_LEARNED.md` after a learning event. The writer marks learned skills `origin: auto` and refuses to overwrite a human-authored target. Missing provenance is treated as human-authored. Curator policy applies to automatically learned skills, not a blanket deletion of all old instructions.

The menu shortens auto-learned descriptions to 80 characters to bound recurring context cost; the full skill body remains available when invoked.

Source: [learning defaults](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/agent/skill-learning/config.ts), [trigger gates](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/agent/skill-learning/trigger.ts), and [provenance-aware writer](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/agent/skill-learning/writer.ts).

## Diagnose a missing skill or tool

Check the exact directory shape, valid YAML frontmatter, and skill name first. An unreadable file can be skipped; a hidden `.pending` candidate is intentionally not a live skill. Then check the generated menu and any same-name workspace override. Missing binary requirements produce warnings, so discovery alone does not establish that a workflow can run.

A skill supplies instructions, while an MCP tool supplies executable capability. Installing a skill does not install its required binary, authenticate a connector, or broaden an agent's tool permissions. Test the smallest read-only tool involved in the workflow, then invoke the skill on a small example.

## Native Claude Code skills in task execution

The orchestration catalog combines gateway-discovered Markdown skills with skills reported by the actual Claude Code worker harness, including bundled and enabled user/plugin skills. A native skill such as `code-review` does not need a gateway `SKILL.md`. Use the exact discovered name rather than guessing it from a directory.

Native discovery performs a Claude Code initialization probe without a user prompt, model call, MCP server, or hooks. The worker rechecks availability in its selected runtime before executing a native skill. `CLI_SKILL_UNAVAILABLE` means it was not available there; the gateway does not silently retry on a different host/container runtime.

For a gateway Markdown skill task, the driver builds a task-specific Claude plugin containing the pinned skill body and supporting resources, then invokes `orchestration-task:<name>`. Plugin requirements that cannot be satisfied are rejected. Symlinks are not copied as skill resources; container transfer also imposes a 10 MiB resource limit.

Host workers use Claude's default native tool set and can retain host runtime customization. Restricted non-host profiles explicitly select native tools, require the generated MCP configuration, disable hooks, and suppress unrelated enabled plugins. Consequently a skill working in an interactive host shell is not proof it will work inside a restricted or container task profile. Check the actual discovered inventory and task error before installing or changing anything.

Source: [native skill discovery](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/orchestration/cli-skills.ts), [skill task preparation](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/orchestration/tasks/driver.ts), and [runtime profile arguments](https://github.com/0xMaxMa/claude-gateway/blob/b917843/src/session/runtime-profile.ts).
