# Development

Keep development builds separate from a gateway serving active users. Rebuilding a live checkout can leave gateway and MCP code from different revisions and interrupt sessions.

## Source setup

```bash
git clone https://github.com/0xMaxMa/claude-gateway.git
cd claude-gateway
npm install
npm run build
```

Node.js 22+ and Bun are required. `postinstall` installs MCP dependencies through Bun when available. Check `claude --version` and authenticate under the operating-system account that runs the gateway. Docker/Compose is required only for app-related development, and audio conversion paths may require `ffmpeg`.

Start a development gateway deliberately:

```bash
npm start
```

It uses the same default config directory as an installed gateway. To test independently, set `GATEWAY_CONFIG`, `PORT`, and distinct agent workspace paths before starting. Do not accidentally start two receivers with the same bot token.

## Repository map

| Path | What belongs here |
| --- | --- |
| `src/agent/` | Claude Code process/session handling, skills, memory and background agent jobs |
| `src/orchestration/` | Durable conversations, worker scheduling, task events and delivery |
| `src/voice/` | STT/TTS adapters, turn handling, transport, diagnostics and replay |
| `src/api/` | HTTP/WebSocket routes, authorization, channel webhooks |
| `src/cli/` | CLI commands, local runtime control and API clients |
| `src/config/` | Loading, defaults, migrations and validation |
| `mcp/` | Bun MCP server and tool modules |
| `tests/` | Unit, integration and end-to-end tests |
| `website/` | Documentation source and its independent build |
| `website/reference/cli.md` | Generated CLI reference |

This map describes the orchestration codebase documented by this site. Runtime data belongs under the configured gateway home and agent workspaces, not inside the repository.

## Test the changed behavior

Use the smallest meaningful test set while iterating. These examples invoke Jest directly to avoid npm's `pretest` build when a rebuild is not needed:

```bash
node --max-old-space-size=1536 node_modules/jest/bin/jest.js --runInBand tests/unit/voice/gemini.test.ts
npm run typecheck
```

The heap size shown is a conservative starting point for a small shared host, not a guaranteed memory bound: Node child processes, native buffers, the compiler, and other services also consume memory. Run builds and tests sequentially on such hosts and monitor available RAM. If the suite needs more memory, move full validation to an appropriately sized CI runner rather than repeatedly exhausting production RAM.

Install `ffmpeg` before running the full unit suite: audio cancellation tests exercise the real decoder. The release workflow installs it explicitly. Test fixtures for legacy AgentRunner behavior must set `gateway.orchestration: false`; omitted settings now enable orchestration and can otherwise invoke CLI discovery through legacy subprocess mocks. Keep orchestration tests enabled explicitly and use temporary config copies when testing loader migrations.

The standard project commands are:

```bash
npm run build
npm run test:unit
npm run integration
npm test
```

`npm test` and `npm run test:unit` have pretest hooks that compile TypeScript. Do not run several full suites or compiler processes at once on the same small machine. A full suite should run in an isolated development/CI environment before release.

For async tests, wait for an observable state or event with a bounded deadline rather than an arbitrary sleep. Test real cancellation and failure paths when changing process supervision; CPU movement alone is not proof that a test passed.

## Release and promote

Push a `vX.Y.Z` tag to release. The release workflow runs the unit tests, builds, creates a GitHub pre-release and publishes the package to the `next` dist-tag. The `latest` dist-tag does not move, so installed gateways do not report an update yet.

Promote a version by running the Promote workflow from the Actions tab with the version number. Its preflight script, `scripts/release/promote-check.sh`, runs five read-only checks. The version must be plain `x.y.z` with no leading `v`. The version must be published on npm. The current `latest` must be older than the version, which refuses demotion and repeated promotion. The version must have been published at least 24 hours ago, so it has soaked on `next`. No newer stable version may have been published within 24 hours after it, because a same-day follow-up usually means the version had a regression.

When every check passes, the workflow points `latest` at the version and clears the pre-release flag on its GitHub Release. Neither CI nor a rebuild runs at promotion. The tarball is the one the release workflow already tested and published. Run the preflight locally before promoting by hand:

```bash
scripts/release/promote-check.sh 2.1.3
npm dist-tag add @0xmaxma/claude-gateway@2.1.3 latest
gh release edit v2.1.3 --prerelease=false --latest
```

### Roll back latest

The preflight refuses to move `latest` to an older version, so the Promote workflow cannot roll back. If a promoted version turns out to be bad, point `latest` back at the previous good version by hand:

```bash
npm view @0xmaxma/claude-gateway dist-tags
npm dist-tag add @0xmaxma/claude-gateway@2.1.2 latest
gh release edit v2.1.2 --latest
```

Installed gateways stop offering the bad version on their next update check. Gateways that already updated stay on it until you ship and promote a fix, because `claude-gateway update` never downgrades.

## Update documentation with code

HTTP API changes belong in [API reference](../api/). Update the relevant channel or feature guide when behavior changes. Regenerate `website/reference/cli.md` with the repository's CLI generator when changing CLI command definitions. Keep examples consistent with configuration validation, authorization and route mounts.

The website is built independently:

```bash
npm --prefix website ci
DOCS_BASE=/claude-gateway/ npm --prefix website run check
```

Checks build the static pages and validate internal links, anchors, assets and JSON example syntax. They do not start a gateway, run a model, contact a channel or certify that an example is accepted by an external provider. Review changed pages at desktop and mobile sizes before publishing.

## Deploy the documentation

The website produces static files in `website/.vitepress/dist`. GitHub Pages hosts this repository at `https://0xmaxma.github.io/claude-gateway/`. `DOCS_BASE=/claude-gateway/` ensures links and assets work under that path. A standalone domain uses `/` instead.

The deployment workflow builds and checks on main, uploads the static artifact and deploys it through GitHub Pages. PR builds validate without publishing. The initial site can be served from `gh-pages` until the docs workflow reaches main; the workflow switches the Pages source to GitHub Actions. No gateway restart or application database is needed to publish documentation.

See the website's contributor instructions in [website/README.md](https://github.com/0xMaxMa/claude-gateway/blob/docs/documentation-site/website/README.md).
