#!/usr/bin/env bash
# Interactive promote: pick a published version and move the npm `stable` dist-tag to it
# through the Promote workflow. Picking a version older than the current stable rolls back.
set -euo pipefail

PACKAGE='@0xmaxma/claude-gateway'
WORKFLOW='promote.yml'
# Explicit, so gh never resolves the repo from a remote such as `upstream`.
REPO='0xMaxMa/claude-gateway'
LIST_SIZE=10

fail() {
  echo "Error: $*" >&2
  exit 1
}

for cmd in npm jq gh; do
  command -v "$cmd" >/dev/null 2>&1 || fail "'$cmd' not found in PATH"
done

times="$(npm view "$PACKAGE" time --json)" || fail "could not read publish times from npm"
tags="$(npm view "$PACKAGE" dist-tags --json)" || fail "could not read dist-tags from npm"

# Capture before use: a jq failure must stop the script, not produce an empty or partial list.
versions="$(jq -r --argjson n "$LIST_SIZE" '
  to_entries
  | map(select(.key | test("^[0-9]+\\.[0-9]+\\.[0-9]+$")))
  | sort_by(.value) | reverse | .[:$n][]
  | "\(.key)\t\(.value)"' <<<"$times")" || fail "could not parse npm publish times"
stable="$(jq -r '.stable // empty' <<<"$tags")" || fail "could not parse npm dist-tags"
latest="$(jq -r '.latest // empty' <<<"$tags")" || fail "could not parse npm dist-tags"
[[ -n "$versions" ]] || fail "no published versions found for $PACKAGE"

echo ""
echo "Current stable: ${stable:-<none — update falls back to latest>}"
echo ""
echo "Recent versions (newest first):"
choices=()
while IFS=$'\t' read -r version published_at; do
  choices+=("$version")
  marks=""
  [[ "$version" == "$latest" ]] && marks+=" latest"
  [[ "$version" == "$stable" ]] && marks+=" stable"
  printf '  %2d) %-10s %s%s\n' "${#choices[@]}" "$version" "${published_at%%T*}" "${marks:+  ←$marks}"
done <<<"$versions"
echo ""
read -rp "Promote which version to stable? [1-${#choices[@]}]: " choice

[[ "$choice" =~ ^[0-9]+$ ]] && ((10#$choice >= 1 && 10#$choice <= ${#choices[@]})) || fail "invalid choice '$choice'"
target="${choices[10#$choice - 1]}"

if [[ "$target" == "$stable" ]]; then
  echo "$target is already stable — nothing to do."
  exit 0
fi

echo ""
echo "  stable: ${stable:-<none>}  →  $target"
read -rp "Confirm promote? [y/N]: " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "Aborted."
  exit 0
fi

gh workflow run "$WORKFLOW" --repo "$REPO" --ref main -f version="$target"

echo ""
echo "Promote workflow started for $target. Follow it with: gh run list --repo $REPO --workflow=$WORKFLOW"
echo "Check the result with: npm view $PACKAGE dist-tags"
