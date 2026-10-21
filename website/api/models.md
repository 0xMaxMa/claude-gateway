# Models API {#models-api}

## GET /api/v1/models {#get-apiv1models}

List the models this gateway offers.

The list starts with configured models and adds live models from `{ANTHROPIC_BASE_URL}/v1/models` when a catalog base URL is configured. Upstream additions appear without touching `config.json`; configured models remain listed until their config entries are removed. `MODELS_BASE_URL` overrides the base URL when the catalog is served separately from the messages endpoint, and `MODELS_API_KEY` / `ANTHROPIC_AUTH_TOKEN` supplies the bearer token; both also resolve from the `env` block of `~/.claude/settings.json`. A successful fetch is cached for 60 seconds and shared between concurrent callers.

`gateway.models` from `config.json` supplies the configured portion of the list. When no base URL is configured, when the URL is `http` to a non-local host (the bearer token is never sent in cleartext), or when the fetch fails, times out, or returns an empty or unparseable catalog, the list contains only configured models. One exception: while fetches are failing, a catalog fetched within the last hour still supplies live-only entries. Past that hour, only configured models remain. A configured row retains its own metadata even when the catalog has the same id. A live-only row uses the catalog's id and display name; if it has no alias or context window, its id becomes its alias and its context window defaults to 200000. A row that identifies itself as a non-chat model (`kind`/`type` of `image`, `audio`, `embedding`, …) is dropped — a proxy that fronts image generation alongside chat may serve one catalog for both, and an image model is not selectable as a chat model. A row that says nothing about its kind is kept.

The catalog keeps configured models first and adds upstream-only models afterward. A configured model omitted by the provider therefore remains visible and selectable until config migration or an explicit config edit removes it. A live-only model is also selectable while the catalog is available.

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  http://localhost:10850/api/v1/models | jq
```

```json
{
  "models": [
    { "id": "claude-opus-5-5",     "name": "Opus 5.5",      "alias": "opus",      "contextWindow": 200000,  "multiplier": 1 },
    { "id": "claude-opus-5-5[1m]", "name": "Opus 5.5 (1M)", "alias": "opus[1m]",  "contextWindow": 1000000, "multiplier": 1 },
    { "id": "claude-opus-5",       "name": "Opus 5",        "alias": "opus5",     "contextWindow": 200000,  "multiplier": 1 },
    { "id": "claude-opus-4-8",     "name": "Opus 4.8",      "alias": "opus48",    "contextWindow": 200000,  "multiplier": 1 },
    { "id": "claude-sonnet-5-5",   "name": "Sonnet 5.5",    "alias": "sonnet",    "contextWindow": 200000,  "multiplier": 1 },
    { "id": "claude-sonnet-5-5[1m]", "name": "Sonnet 5.5 (1M)", "alias": "sonnet[1m]", "contextWindow": 1000000, "multiplier": 1 },
    { "id": "claude-sonnet-5",     "name": "Sonnet 5",      "alias": "sonnet5",   "contextWindow": 200000,  "multiplier": 1 },
    { "id": "claude-haiku-5-5",    "name": "Haiku 5.5",     "alias": "haiku",     "contextWindow": 200000,  "multiplier": 1 },
    { "id": "gpt-6-sol[1m]",       "name": "GPT 6 Sol",     "alias": "gpt6sol",   "contextWindow": 1050000, "multiplier": 1 },
    { "id": "gpt-6-astra[1m]",     "name": "GPT 6 Astra",   "alias": "gpt6astra", "contextWindow": 1050000, "multiplier": 1 },
    { "id": "gpt-6-luna[1m]",      "name": "GPT 6 Luna",    "alias": "gpt6luna",  "contextWindow": 1050000, "multiplier": 1 },
    { "id": "gpt-6.1-sol[1m]",        "name": "GPT 6.1 Sol",   "alias": "gpt61sol",  "contextWindow": 1050000, "multiplier": 1 }
  ]
}
```

> The bare family alias always points at the newest model of that family (`opus` → Opus 5.5, `sonnet` → Sonnet 5.5, `haiku` → Haiku 5.5); older members keep a versioned alias (`opus5`, `opus48`, `sonnet5`, `haiku45`). This is a representative subset — the endpoint returns the full list.

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
