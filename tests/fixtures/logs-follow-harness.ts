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
 * `process.exitCode` rather than `process.exit()`: stdout is a pipe here, and
 * exiting outright can discard writes the test is about to assert on.
 */
import { runCli } from '../../src/cli/index';

runCli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`${(err as Error)?.stack ?? String(err)}\n`);
    process.exitCode = 1;
  });
