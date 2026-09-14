# Documentation website

Standalone VitePress site. Requires Node.js 22+. It has its own package and lockfile and does not install or build the gateway.

```bash
cd website
npm ci
npm run dev
```

Open the loopback URL printed by VitePress. Run `npm run check` for the production build, generated internal-link/anchor checks, and structural JSON example checks. Run `npm run preview` to inspect the generated site.

## Contributing

Start at [index.md](./index.md). Keep pages practical: prerequisites, a minimal action, its expected outcome, and a link to the full repository reference. Verify commands and fields against source. Public documentation is English; use placeholders for credentials and identifiers.

The main guide is scoped to main at `650dc67`, package 1.8.14. All PR #465 orchestration/task/voice material must remain visibly marked unreleased until it actually merges; then verify and update the version scope. Keep root API.md and generated CLI.md authoritative instead of duplicating their complete inventories. Never read or publish ignored private notes as site content.

VitePress [stable 1.6.4](https://vuejs.github.io/vitepress/v1/guide/getting-started) is pinned independently of the gateway. A scoped Vite 6.4.3 override replaces its older Vite 5 dependency to include development-server security fixes; recheck builds and the dependency audit when updating it. Search indexes local site content; the site uses system fonts and no analytics or remote font service.

CI builds and checks only this website. The deployment workflow publishes checked builds to GitHub Pages on main changes or a manual dispatch on main. PR builds cannot deploy. Initial publication uses the `gh-pages` branch while this PR remains open; the first main deployment switches Pages to GitHub Actions. To prepare assets for a host subpath, run `DOCS_BASE=/claude-gateway/ npm run check`; the resulting `.vitepress/dist` targets the project Pages URL. The default base `/` supports a standalone domain. Do not place generated output in the gateway's runtime `dist`.

Link checks cover generated same-site pages, assets, and fragments, including sidebar/navigation links. External sources are not fetched during CI. The JSON check validates syntax of JSON examples and template field/type compatibility of the configuration excerpt; it does not boot a gateway or contact providers.
