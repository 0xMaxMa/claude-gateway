/**
 * Standalone CLI stand-in for tests/integration/cli-logs-follow.test.ts.
 *
 * `gateway logs --follow` is the one CLI path whose correctness is a property
 * of the *process*, not of the function: it works only if something keeps the
 * event loop alive between polls. That cannot be observed from inside Jest,
 * whose own handles keep the loop alive for any code under test — which is
 * exactly how #439 shipped with three passing follow tests.
 *
 * So this harness is deliberately bare: it runs the real `runCli` and holds no
 * handle of its own, leaving the follow poller as the only thing that can keep
 * the process from exiting.
 *
 * It exits the way `src/entry.ts` does — `exitAfterFlush`, not a bare
 * `process.exitCode` — because stdout here is a pipe, and draining it before
 * exiting is precisely the production behaviour these tests are asserting on.
 * A harness that exited differently would be testing a CLI that does not ship.
 *
 * `LOGS_HARNESS_EXIT=bare` drops that final drain. It exists for one assertion:
 * that the command settles its own stdout rather than relying on whatever the
 * caller happens to do next. `exitAfterFlush` re-attaches an `'error'` listener
 * of its own a tick later, so for a while a write still in flight when
 * `runGatewayLogs` returned was caught by that listener purely by timing — the
 * bare mode is the same CLI with that safety net removed.
 */
import { runCli } from '../../src/cli/index';
import { exitAfterFlush } from '../../src/cli/output';

const bare = process.env.LOGS_HARNESS_EXIT === 'bare';

async function finish(code: number): Promise<void> {
  if (bare) {
    process.exitCode = code;
    return;
  }
  await exitAfterFlush(code);
}

runCli(process.argv.slice(2))
  .then(finish)
  .catch(async (err: unknown) => {
    process.stderr.write(`${(err as Error)?.stack ?? String(err)}\n`);
    await finish(1);
  });
