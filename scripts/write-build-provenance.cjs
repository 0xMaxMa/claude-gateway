#!/usr/bin/env node
// This runs after compilation and travels with dist in release packages. Never
// infer the compiled revision from a checkout that may have moved after build.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function git(...args) {
  try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim(); }
  catch { return null; }
}
const top = git('rev-parse', '--show-toplevel');
const isCheckout = top !== null && fs.realpathSync(top) === fs.realpathSync(root);
const status = isCheckout ? git('status', '--porcelain', '--untracked-files=normal') : null;
const manifest = {
  schemaVersion: 1,
  packageVersion: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
  builtAt: new Date().toISOString(),
  commit: isCheckout ? git('rev-parse', 'HEAD') : null,
  tag: isCheckout ? git('describe', '--tags', '--exact-match', 'HEAD') : null,
  dirty: status === null ? null : status.length > 0,
};
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'build-provenance.json'), JSON.stringify(manifest, null, 2) + '\n');
