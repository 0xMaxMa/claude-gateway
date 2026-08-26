/**
 * Minimal stand-in for the gateway entry point, used by
 * tests/integration/sighup-orphan-receivers.test.ts.
 *
 * It wires signals through the *real* registerShutdownSignals and supervises a
 * real child, so the test exercises the actual OS behaviour that issue #405 is
 * about: Node's default disposition for SIGHUP terminates the process without
 * running handlers, which is what orphaned every receiver.
 */
import { spawn } from 'child_process';
import { registerShutdownSignals } from '../../src/shutdown-signals';

const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
  stdio: 'ignore',
});

process.stdout.write(`CHILD ${child.pid}\n`);

registerShutdownSignals({
  run: async (signal) => {
    process.stdout.write(`SHUTDOWN ${signal}\n`);
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  },
});

// Keep the harness alive until a signal arrives.
setInterval(() => {}, 1000);
