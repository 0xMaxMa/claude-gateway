#!/usr/bin/env bash
set -e

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != "main" ]]; then
  echo "Error: must be on 'main' branch to release (currently on '$BRANCH')"
  exit 1
fi

if [[ -n $(git status --porcelain) ]]; then
  echo "Error: working tree is not clean — commit or stash changes first"
  exit 1
fi

CURRENT=$(node -p "require('./package.json').version")

echo ""
echo "Current version: v$CURRENT"
echo ""
echo "Select release type:"
echo "  1) patch  (bug fix)"
echo "  2) minor  (new feature)"
echo "  3) major  (breaking change)"
echo ""
read -rp "Choice [1/2/3]: " choice

case $choice in
  1) TYPE=patch ;;
  2) TYPE=minor ;;
  3) TYPE=major ;;
  *) echo "Invalid choice"; exit 1 ;;
esac

NEXT=$(npm version "$TYPE" --no-git-tag-version --dry-run 2>/dev/null | tr -d 'v')

echo ""
echo "  v$CURRENT  →  v$NEXT  ($TYPE)"
echo ""
read -rp "Confirm release? [y/N]: " confirm

if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "Aborted."
  exit 0
fi

npm version "$TYPE"

if ! git push; then
  echo ""
  echo "Error: git push failed — reverting version bump"
  git tag -d "v$NEXT" 2>/dev/null || true
  git reset --hard HEAD~1
  exit 1
fi

if ! git push --tags; then
  echo ""
  echo "Error: git push --tags failed"
  echo "The version commit was already pushed. Push the tag manually:"
  echo "  git push origin v$NEXT"
  exit 1
fi

echo ""
echo "Released v$NEXT — GitHub Actions will publish to npm automatically."
