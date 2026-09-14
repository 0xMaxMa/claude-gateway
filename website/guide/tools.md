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

Skills hot-reload. Ask the agent to review a small note and verify that its answer cites the file. Agent-specific and shared skill locations are documented in the [skill reference](https://github.com/0xMaxMa/claude-gateway/blob/main/README.md#agent-skills).

## Automatic skill learning

`gateway.skillLearning` controls background review of substantive work. It can create or update automatically learned skills, with daily and total limits and an audit in `SKILLS_LEARNED.md`. The provenance guard preserves human-authored skills. Review the audit when evaluating what the agent learned.

Connector availability and agent tool permissions also affect what a session can do. See [configuration](../reference/configuration.md) and the [full tool architecture](https://github.com/0xMaxMa/claude-gateway/blob/main/README.md#mcp-tool-system).
