# Skill API {#skill-api}

Manage per-agent and shared skills. Skills are `SKILL.md` files stored in the agent workspace or shared directory.

## GET /api/v1/agents/:agentId/skills {#get-apiv1agentsagentidskills}

List all skills for an agent (workspace + module + shared).

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  http://localhost:10850/api/v1/agents/alfred/skills | jq
```

```json
[
  {
    "key": "my-helper",
    "name": "my-helper",
    "description": "Does something useful",
    "scope": "workspace",
    "emoji": null,
    "userInvocable": true,
    "modulePrefix": null,
    "source_url": null
  }
]
```

**Scope values:** `workspace`, `shared`, `module`

---

## GET /api/v1/agents/:agentId/skills/:name {#get-apiv1agentsagentidskillsname}

Get a single skill's content. Optional query param `?scope=workspace|shared` to disambiguate when the same name exists in multiple scopes.

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  "http://localhost:10850/api/v1/agents/alfred/skills/my-helper" | jq
```

```json
{
  "key": "my-helper",
  "name": "my-helper",
  "description": "Does something useful",
  "scope": "workspace",
  "emoji": null,
  "content": "---\nname: my-helper\ndescription: \"Does something useful\"\n---\n\nInstructions here.",
  "source_url": null
}
```

---

## POST /api/v1/agents/:agentId/skills {#post-apiv1agentsagentidskills}

Create a new skill. Requires write access. Use `scope: "shared"` with an admin key to create a shared skill.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Skill slug — lowercase alphanumeric + hyphens, 1-64 chars |
| `description` | Yes | One-line description |
| `content` | Yes | Skill instructions (Markdown body, excluding frontmatter) |
| `scope` | No | `"workspace"` (default) or `"shared"` (admin only) |

```bash
curl -X POST \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-helper",
    "description": "Does something useful",
    "content": "When invoked, do the following:\n1. Step one\n2. Step two"
  }' \
  http://localhost:10850/api/v1/agents/alfred/skills | jq
```

```json
{
  "key": "my-helper",
  "name": "my-helper",
  "description": "Does something useful",
  "scope": "workspace",
  "emoji": null,
  "userInvocable": true,
  "modulePrefix": null,
  "content": "---\nname: my-helper\ndescription: \"Does something useful\"\n---\n\nWhen invoked...",
  "source_url": null
}
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | Invalid skill name, reserved name, or missing fields |
| 403 | No write access, or `shared` scope without admin key |
| 409 | Skill with that name already exists |

---

## POST /api/v1/agents/:agentId/skills/install {#post-apiv1agentsagentidskillsinstall}

Install a skill from a GitHub URL or raw URL pointing to a `SKILL.md` file. Requires admin key.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `url` | Yes | HTTPS URL to `SKILL.md` (GitHub URLs auto-converted to raw) |
| `scope` | No | `"workspace"` (default) or `"shared"` |
| `name` | No | Override skill name (default: parsed from frontmatter) |
| `force` | No | `true` to overwrite an existing skill |

```bash
curl -X POST \
  -H "X-Api-Key: admin-key-456" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://github.com/owner/repo/blob/main/skills/my-skill/SKILL.md",
    "scope": "shared"
  }' \
  http://localhost:10850/api/v1/agents/alfred/skills/install | jq
```

```json
{
  "key": "my-skill",
  "name": "my-skill",
  "description": "Skill from GitHub",
  "scope": "shared",
  "emoji": null,
  "userInvocable": true,
  "modulePrefix": null,
  "content": "---\nname: my-skill\n...",
  "source_url": "https://github.com/owner/repo/blob/main/skills/my-skill/SKILL.md"
}
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | Missing/non-HTTPS URL, private host, fetch failure, invalid SKILL.md |
| 400 | SKILL.md exceeds 100KB |
| 403 | Not an admin key |
| 409 | Skill already exists and `force` not set |

---

## DELETE /api/v1/agents/:agentId/skills/:name {#delete-apiv1agentsagentidskillsname}

Delete a skill by name. Requires write access. Use `?scope=shared` (admin only) to delete a shared skill.

```bash
curl -X DELETE \
  -H "X-Api-Key: my-secret-key-123" \
  "http://localhost:10850/api/v1/agents/alfred/skills/my-helper" | jq
```

```json
{ "message": "Skill \"my-helper\" deleted from workspace" }
```

---

## GET /api/v1/agents/:agentId/skill-metrics {#get-apiv1agentsagentidskill-metrics}

Skill self-improvement (skill-learning) effectiveness rollup for the agent. Read-only; any key with access to the agent. Returns `404` if skill-learning is not active for the agent.

The metrics all derive from durable per-turn telemetry (`turn_metrics`) and per-skill provenance/usage (`skill_stats`) captured in the agent's `history.db`:

- **adoption** — funnel of auto-skills: created → loaded ≥1 → loaded ≥3 (`stickyPct` = % reaching ≥3 uses).
- **costDelta** — median tool-calls / tokens for turns with **no skill loaded** vs turns with **a skill loaded** (a global cohort comparison, not a temporal per-skill before/after), plus the number of intent clusters (directional). Each median is `null` when its cohort has no turns yet (distinct from a measured `0`).
- **recovery** — recovery-triage rate for the earlier half vs the recent half of turns (should trend down).
- **cohort** — the `enabled` on/off A/B: turn counts + median tool-calls per cohort (the causal signal).
- **netTokens** — the bottom line: `savedByReuse − spentReviewing` (`net`). The feature is a win only when `net > 0`.

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  "http://localhost:10850/api/v1/agents/alfred/skill-metrics" | jq
```

```json
{
  "agentId": "alfred",
  "generatedAt": 1723800000000,
  "adoption": { "autoSkills": 4, "loadedAtLeast1": 3, "loadedAtLeast3": 2, "stickyPct": 50 },
  "costDelta": { "clusters": 6, "medianToolCallsBefore": 9, "medianToolCallsAfter": 4, "medianTokensBefore": 12000, "medianTokensAfter": 6000 },
  "recovery": { "ratePctRecent": 4, "ratePctEarlier": 11 },
  "cohort": { "enabledTurns": 120, "disabledTurns": 40, "enabledMedianToolCalls": 5, "disabledMedianToolCalls": 8 },
  "netTokens": { "savedByReuse": 48000, "spentReviewing": 9000, "net": 39000 }
}
```

**Skill Learning (behavior).** When `gateway.skillLearning.enabled` is true (the shipped default, injected by config migration at `configVersion` `1.0.18`), after a *qualifying* session goes idle a **print-only** reviewer (`claude -p`, no tools, no `--dangerously-skip-permissions`, async spawn) distils the transcript into a skill *proposal*. The **gateway**, not the model, writes the file via a provenance-guarded writer: learned skills are stamped `origin: auto` in frontmatter and land in the agent's **workspace** `skills/` dir, live on the next turn via the existing hot-reload — `mode: "propose"` writes to a `skills/.pending/` review queue instead. A session qualifies when its peak tool-calls ≥ `minToolCalls`, or a recovery fired, or a user-correction heuristic matched — capped per day (`maxReviewsPerDay`). A **daily curator** prunes `origin: auto` skills that are both unused (`< minUsesToKeep`) and stale (`> maxAgeDays`), enforces `maxAutoSkills` (LRU), and never touches hand-authored or `pinned` skills. Telemetry capture is always-on (even when disabled) so the `enabled` on/off cohort remains computable. Config lives under `gateway.skillLearning` with per-agent overrides honored over the global default.

**Skill Learning (notifications).** Every live auto-write appends an audit line to `<workspace>/SKILLS_LEARNED.md` (always on). When `skillLearning.notify` is true (default), a short ping is also **fanned out to every channel the agent has configured** — Telegram, Discord, and LINE — via a transport registry. Each channel resolves its own recipients from `<workspace>/.<channel>-state/access.json` → `allowFrom`: Telegram sends directly (chat_id == user_id), Discord opens a DM channel for each user then posts, LINE pushes via the Messaging API (dormant until a LINE access token is configured). The web/`api` channel has no proactive push and is not notified. A burst of writes coalesces into a single digest. Notifications are best-effort and never block the review path.

**Skill Learning (menu size).** The CLAUDE.md **AVAILABLE SKILLS** menu compacts `origin: auto` skill descriptions to a short one-liner (full body still loads on invoke); hand-authored, module, and shared skills keep their full descriptions. This keeps CLAUDE.md bounded as auto-skills accumulate toward `maxAutoSkills`.

---
