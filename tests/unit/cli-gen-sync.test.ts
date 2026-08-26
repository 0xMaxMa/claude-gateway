import * as fs from 'fs';
import { buildOutputs, COMMANDS_FILE, CLI_DOC_FILE } from '../../scripts/gen-cli';

/**
 * Drift guard: the committed generated files must match what the current route
 * manifest produces. If this fails, a route's CLI mapping changed without
 * regenerating — run `npm run gen-cli`. This is the DRY enforcement that lets
 * "add a defineRoute" be the single edit for API + CLI + docs.
 */
describe('cli generated files are in sync with the route manifest', () => {
  const { commands, doc } = buildOutputs();

  it('src/cli/commands.generated.ts is up to date (run `npm run gen-cli` if this fails)', () => {
    expect(fs.readFileSync(COMMANDS_FILE, 'utf8')).toBe(commands);
  });

  it('CLI.md is up to date (run `npm run gen-cli` if this fails)', () => {
    expect(fs.readFileSync(CLI_DOC_FILE, 'utf8')).toBe(doc);
  });
});
