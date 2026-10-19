#!/usr/bin/env bash
# Read-only preflight before moving the latest dist-tag to <version>.
# Usage: promote-check.sh <version>
set -euo pipefail

PACKAGE='@0xmaxma/claude-gateway'
FOLLOW_UP_WINDOW_SECONDS=86400
MIN_SOAK_SECONDS=86400

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "ok: $*"
}

semver_lt() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    split(a, x, "."); split(b, y, ".")
    for (i = 1; i <= 3; i++) {
      if (x[i] + 0 < y[i] + 0) exit 0
      if (x[i] + 0 > y[i] + 0) exit 1
    }
    exit 1
  }'
}

# npm records milliseconds, which jq's fromdateiso8601 rejects.
publish_epoch() {
  jq -r --arg v "$2" '.[$v] // empty | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601' <<<"$1"
}

stable_versions_published_between() {
  jq -r --argjson from "$2" --argjson to "$3" '
    to_entries[]
    | select(.key | test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))
    | select((.value | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) as $t | $t > $from and $t <= $to)
    | .key' <<<"$1"
}

main() {
  local version="${1:-}"
  [[ $# -eq 1 ]] || fail "usage: promote-check.sh <version>"

  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
    || fail "version '$version' is not plain x.y.z (no leading v)"
  pass "version format: $version"

  local published
  published="$(npm view "$PACKAGE@$version" version 2>/dev/null || true)"
  [[ "$published" == "$version" ]] \
    || fail "$PACKAGE@$version is not published on npm (npm view returned '$published')"
  pass "published on npm: $PACKAGE@$version"

  local latest
  latest="$(npm view "$PACKAGE" dist-tags.latest)"
  semver_lt "$latest" "$version" \
    || fail "latest is $latest, which is not older than $version (refusing demotion or re-promotion)"
  pass "latest is $latest, older than $version"

  local times published_iso published_at
  times="$(npm view "$PACKAGE" time --json)"
  published_iso="$(jq -r --arg v "$version" '.[$v] // empty' <<<"$times")"
  published_at="$(publish_epoch "$times" "$version")" \
    || fail "could not parse publish time for $version"
  [[ -n "$published_at" ]] || fail "no publish time recorded for $version"
  pass "published $published_iso"

  # Without a soak, the follow-up check below passes trivially because no fix has had time to ship.
  local age=$(($(date +%s) - published_at))
  ((age >= MIN_SOAK_SECONDS)) \
    || fail "$version was published $((age / 3600))h ago; it must soak on next for at least $((MIN_SOAK_SECONDS / 3600))h"
  pass "soaked on next for $((age / 3600))h"

  # Capture first: a jq failure inside process substitution would not stop the loop.
  local candidates
  candidates="$(stable_versions_published_between "$times" "$published_at" $((published_at + FOLLOW_UP_WINDOW_SECONDS)))" \
    || fail "could not parse npm publish times"

  local follow_ups=() candidate
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] || continue
    if semver_lt "$version" "$candidate"; then
      follow_ups+=("$candidate")
    fi
  done <<<"$candidates"
  [[ ${#follow_ups[@]} -eq 0 ]] \
    || fail "follow-up release within 24h of $version: ${follow_ups[*]}"
  pass "no newer stable release within 24h after $version"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
