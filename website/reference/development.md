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
| `CLI.md` | Generated CLI reference |

This map describes the orchestration codebase documented by this site. Runtime data belongs under the configured gateway home and agent workspaces, not inside the repository.

## Test the changed behavior

Use the smallest meaningful test set while iterating. These examples invoke Jest directly to avoid npm's `pretest` build when a rebuild is not needed:

```bash
node --max-old-space-size=1536 node_modules/jest/bin/jest.js --runInBand tests/unit/voice/gemini.test.ts
npm run typecheck
```

The heap size shown is a conservative starting point for a small shared host, not a guaranteed memory bound: Node child processes, native buffers, the compiler, and other services also consume memory. Run builds and tests sequentially on such hosts and monitor available RAM. If the suite needs more memory, move full validation to an appropriately sized CI runner rather than repeatedly exhausting production RAM.

The standard project commands are:

```bash
npm run build
npm run test:unit
npm run integration
npm test
```

`npm test` and `npm run test:unit` have pretest hooks that compile TypeScript. Do not run several full suites or compiler processes at once on the same small machine. A full suite should run in an isolated development/CI environment before release.

For async tests, wait for an observable state or event with a bounded deadline rather than an arbitrary sleep. Test real cancellation and failure paths when changing process supervision; CPU movement alone is not proof that a test passed.

## Update documentation with code

HTTP API changes belong in [API reference](../api/). Update the relevant channel or feature guide when behavior changes. Regenerate `CLI.md` with the repository's CLI generator when changing CLI command definitions. Keep examples consistent with configuration validation, authorization and route mounts.

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
