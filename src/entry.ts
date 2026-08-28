#!/usr/bin/env node

/**
 * Executable entry point.
 *
 * Deliberately tiny. `src/index.ts` pulls the whole server graph in at module
 * scope — router, agent runner, app installer, cron manager, the sqlite-backed
 * history and knowledge stores — because it *is* the server. Dispatching from
 * there meant every CLI invocation paid that cost and inherited its failures:
 * `claude-gateway --help` loaded sqlite and printed Node's experimental-feature
 * warning before the banner, and `doctor`/`debug-bundle`, whose whole purpose is
 * to work when the server does not, could be brought down by a module-load
 * error in it.
 *
 * So the decision is made here, before either side is loaded, and only the side
 * that is actually needed gets imported.
 *
 * `src/index.ts` keeps its own dispatch: service units written before this
 * split run `dist/index.js gateway start`, and those must keep booting.
 */
import { loadGatewayDotenv } from './load-dotenv';

// Before anything reads process.env — the server boots from these variables and
// the CLI resolves the gateway's address from the same $GATEWAY_BIND.
loadGatewayDotenv();

import { classifyInvocation, isDirectSystemdChild } from './cli/command-names';

const invocation = classifyInvocation(process.argv.slice(2), process.env, {
  hasTty: process.stdin.isTTY === true,
  // Only `isSupervised()` -> the INVOCATION_ID branch reads this; skip the
  // /proc read entirely otherwise (the common bare-terminal and boot cases).
  parentIsSystemd: process.env.INVOCATION_ID ? isDirectSystemdChild() : undefined,
});

if (invocation === 'boot' || invocation === 'legacy-boot') {
  // Importing the server module runs its own dispatch, which re-classifies this
  // same argv and starts main(). Nothing else to do here.
  import('./index').catch((err) => {
    process.stderr.write(`Failed to start gateway: ${err?.message ?? err}\n`);
    process.exit(1);
  });
} else {
  import('./cli')
    .then(({ runCli }) => runCli(process.argv.slice(2)))
    .then(async (code) => {
      const { exitAfterFlush } = await import('./cli/output');
      await exitAfterFlush(code);
    })
    .catch(async (err) => {
      process.stderr.write(`Error: ${err?.message ?? err}\n`);
      const { exitAfterFlush } = await import('./cli/output');
      await exitAfterFlush(1);
    });
}
