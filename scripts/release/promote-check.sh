#!/usr/bin/env bash
# Read-only preflight before moving the stable dist-tag to <version>.
# Any published version may be promoted, including one older than the current stable (rollback).
# Usage: promote-check.sh <version>
set -euo pipefail

PACKAGE='@0xmaxma/claude-gateway'

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

main() {
  [[ $# -eq 1 ]] || fail "usage: promote-check.sh <version>"
  local version="$1"

  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
    || fail "version '$version' is not plain x.y.z (no leading v)"
  echo "ok: version format: $version"

  local published
  published="$(npm view "$PACKAGE@$version" version 2>/dev/null || true)"
  [[ "$published" == "$version" ]] \
    || fail "$PACKAGE@$version is not published on npm (npm view returned '$published')"
  echo "ok: published on npm: $PACKAGE@$version"
}

main "$@"
