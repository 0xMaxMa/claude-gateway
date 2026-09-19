# Worker harnesses

The conversational Agent continues to run Claude Code. Background workers can opt into native Codex for GPT models while retaining the gateway's task lifecycle and scoped MCP tools. The default remains Claude for all workers.

## Configure routing

Set `gateway.workers` in the gateway configuration, then restart the gateway while idle to apply harness changes:

```json
{
  "gateway": {
    "workers": {
      "harness": "auto",
      "codex": {
        "baseUrl": "https://your-provider.example/v1",
        "apiKeyEnv": "OPENAI_API_KEY",
        "reasoningEffort": "medium"
      }
    }
  }
}
```

Set the named credential environment variable in the gateway service environment. Configuration stores its name, never its value. The URL must support the **Responses API**; an Anthropic Messages endpoint is not compatible. Do not reuse `ANTHROPIC_BASE_URL` unless that service separately exposes a supported Responses endpoint. URLs must use HTTPS, except local HTTP, and cannot contain credentials, query strings, or fragments.

`harness: "auto"` selects Codex for GPT model IDs, including `openai/` and `chatgpt/` prefixes; other models use Claude. `harness: "claude"` retains the existing worker harness. `harness: "codex"` explicitly routes workers to Codex; select a model supported by your Responses provider. Agent-level `workers` settings override the gateway defaults, and nested Codex settings merge field by field.

Existing model entries in `gateway.models` can declare worker routing and provider model names:

```json
{
  "id": "gpt-5.6-luna[1m]",
  "alias": "fast-worker",
  "workerHarness": "codex",
  "workerModel": "gpt-5.6-luna"
}
```

`workerHarness` affects automatic routing. `workerModel` maps a gateway selection to the native provider model. Without an explicit mapping, native model names drop only Claude context suffixes such as `[1m]`; provider namespaces such as `chatgpt/` are preserved so BYOK routing cannot silently switch to a managed pool. Available reasoning settings are `low`, `medium`, `high`, and `xhigh`; support depends on the chosen model/provider. `codex.bin` may specify an executable path, not a shell command with arguments.

A missing executable, credential, incompatible endpoint, or unsupported model fails the task explicitly. There is no silent switch to Claude or host execution.

## Deploy app containers

New generated app-agent images install native Codex 0.154.0 for AMD64 or ARM64. Downloads are pinned and verified with SHA-512, and the image retains the native runtime's bundled resources. Host Codex configuration and credential directories are not mounted.

Existing app-agent containers need their generated image rebuilt and the **agent service** recreated before using Codex. Merely restarting the gateway, restarting a container, or running the legacy credential-mount migration does not install the new executable. Regenerate the app service configuration through the normal app update/reconfiguration flow, then rebuild/recreate the agent service during a suitable maintenance window. Do not recreate the database or delete app volumes.

Execution stays inside the admitted app container under its normal UID and security restrictions. The gateway bridges only the existing scoped container task tools: progress reporting, requesting input, and staging files. Container workers do not gain host media/browser/memory access. Missing or rejected container bindings never select a host process.

Expired or replaced Codex session homes are reclaimed in bounded background batches when another worker starts. Warm pool sessions and active leases are retained. Leases left after a crash or unconfirmed process stop are conservatively preserved; cleanup does not assume those processes have stopped. Unknown legacy metadata is not deleted automatically.

## Run the opt-in smoke benchmark

The repository includes a small billable benchmark of the two native CLIs:

```bash
node scripts/orchestration/benchmark-worker-harnesses.cjs --run \
  --claude-model 'gpt-5.6-luna[1m]' \
  --codex-model gpt-5.6-luna \
  --output /tmp/worker-benchmark.json
```

Without `--run`, the script only prints usage. It uses existing local CLI authentication, runs one worker at a time with a 120-second limit, and creates separate scratch fixtures. Each worker implements the same integer-sum function; an independent Node harness checks normal inputs, invalid inputs, and overflow. Scratch files are removed afterward. No gateway configuration changes are made.

For an explicit Responses endpoint, add `--codex-base-url https://your-provider.example/v1 --codex-api-key-env OPENAI_API_KEY`. Use `--claude-base-url` to select the Anthropic-compatible route separately. Credentials remain in environment variables or existing CLI authentication storage; never pass the secret as an argument. The script loads only Claude credential/endpoint environment keys from local Claude settings and tells Codex to ignore user configuration and policy rules while retaining authentication. Missing credentials produce a clear skipped result and unsuccessful exit status. Unavailable CLIs and provider failures also produce unsuccessful status; they do not trigger fallback.

Explicit environment values take precedence over local settings. To compare both routes with a chosen credential, use `--claude-api-key-env BENCHMARK_KEY --codex-api-key-env BENCHMARK_KEY`; this selects Claude's bare API-key mode and disables local setting sources so saved environment settings cannot overwrite the chosen credential. Otherwise Claude retains its normal authentication behavior. Codex uses `workspace-write` sandboxing by default. The optional `--host-execution` switch instead matches an explicitly authorized host worker's execution permissions and is recorded in the report; use it only on a suitable test host.

The JSON report contains correctness, elapsed time, CLI status, tool/provider error counts, and available input/cache/output token totals. It does not save raw provider output, account identifiers, credential files, or endpoint URLs. Token accounting differs between CLIs; unavailable values are `null`.

This is a native CLI coding smoke check, **not** a gateway integration benchmark or proof of quality parity. Different endpoint/account routes, cache state, model mappings, and CLI settings can affect results. A timing or token difference does not establish a controlled cost comparison. Test real gateway tasks separately, including MCP calls, cancellation, progress/checkpoint behavior, and container execution.
