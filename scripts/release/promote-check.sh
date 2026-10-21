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

  # npm answers a missing version with E404; any other failure means the
  # registry could not be asked, which must not read as "not published".
  local published err
  err="$(mktemp)"
  if ! published="$(npm view "$PACKAGE@$version" version 2>"$err")"; then
    if grep -q 'E404' "$err"; then
      rm -f "$err"
      fail "$PACKAGE@$version is not published on npm"
    fi
    cat "$err" >&2
    rm -f "$err"
    fail "could not reach the npm registry to check $PACKAGE@$version"
  fi
  rm -f "$err"
  [[ "$published" == "$version" ]] \
    || fail "$PACKAGE@$version is not published on npm (npm view returned '$published')"
  echo "ok: published on npm: $PACKAGE@$version"
}

main "$@"
