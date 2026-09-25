# Models API {#models-api}

## GET /api/v1/models {#get-apiv1models}

List the models this gateway offers.

The list is fetched **live** from `{ANTHROPIC_BASE_URL}/v1/models` when a catalog base URL is configured, so a model added, removed, or reordered upstream shows up here without touching `config.json`. `MODELS_BASE_URL` overrides the base URL when the catalog is served separately from the messages endpoint, and `MODELS_API_KEY` / `ANTHROPIC_AUTH_TOKEN` supplies the bearer token; both also resolve from the `env` block of `~/.claude/settings.json`. A successful fetch is cached for 60 seconds and shared between concurrent callers.

`gateway.models` from `config.json` is the fallback, used when no base URL is configured, when the URL is `http` to a non-local host (the bearer token is never sent in cleartext), or when the fetch fails, times out, or returns an empty or unparseable catalog. One exception: while fetches are failing, a catalog fetched within the last hour is served instead of the configured list — dropping to the provisioning-time list on a blip would make a model that exists only upstream vanish from its own picker. Past that hour the configured list takes over. A catalog response supplies `id` and the display name; `alias`, `contextWindow` and `multiplier` are carried over from the configured entry with the same id, and a model with no configured counterpart gets its id as its alias and a 200000 context window. A row that identifies itself as a non-chat model (`kind`/`type` of `image`, `audio`, `embedding`, …) is dropped — a proxy that fronts image generation alongside chat may serve one catalog for both, and an image model is not selectable as a chat model. A row that says nothing about its kind is kept.

The catalog **replaces** the configured list rather than merging with it, so a model withdrawn upstream disappears from the picker instead of lingering. A configured model the catalog omits stays *addressable* — `/model <id or alias>` still accepts it, and it keeps its configured context window — so switching to a live-only model is never a one-way door.

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  http://localhost:10850/api/v1/models | jq
```

```json
{
  "models": [
    { "id": "claude-opus-5-5",     "name": "Opus 5.5",      "alias": "opus",     "contextWindow": 200000,  "multiplier": 1 },
    { "id": "claude-opus-5-5[1m]", "name": "Opus 5.5 (1M)", "alias": "opus[1m]", "contextWindow": 1000000, "multiplier": 1 },
    { "id": "claude-opus-5",       "name": "Opus 5",        "alias": "opus5",    "contextWindow": 200000,  "multiplier": 1 },
    { "id": "claude-opus-4-8",     "name": "Opus 4.8",      "alias": "opus48",   "contextWindow": 200000,  "multiplier": 1 },
    { "id": "claude-sonnet-5",     "name": "Sonnet 5",      "alias": "sonnet",   "contextWindow": 200000,  "multiplier": 1 },
    { "id": "gpt-6-sol[1m]",       "name": "GPT 6 Sol",     "alias": "gpt6sol",  "contextWindow": 1050000, "multiplier": 1 },
    { "id": "gpt-5.6-sol[1m]",     "name": "GPT 5.6 Sol",   "alias": "gpt56sol", "contextWindow": 1050000, "multiplier": 1 }
  ]
}
```

> The bare family alias always points at the newest model of that family (`opus` → Opus 5.5, `sonnet` → Sonnet 5); older members keep a versioned alias (`opus5`, `opus48`). This is a representative subset — the endpoint returns the full list.

The `get_models` command the chat receivers call for their model picker resolves through the same catalog and the same fallback, so the picker and this endpoint never disagree.

---

## PUT /api/v1/agents/:agentId/model {#put-apiv1agentsagentidmodel}

Set the active model for a specific agent. Persists to `config.json`. Requires admin key.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `model` | Yes | Claude model ID (e.g. `"claude-opus-4-8"`) |

```bash
curl -X PUT \
  -H "X-Api-Key: admin-key-456" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-opus-4-8"}' \
  http://localhost:10850/api/v1/agents/alfred/model | jq
```

```json
{ "model": "claude-opus-4-8" }
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | Missing or unknown model ID |
| 403 | Not an admin key |
| 404 | Agent not found |

---
