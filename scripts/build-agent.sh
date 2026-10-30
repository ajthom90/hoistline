#!/usr/bin/env bash
# Builds hoistline-agent as single-file executables (no Node needed) with bun:
#   dist-bin/hoistline-agent-{darwin-arm64,darwin-x64,linux-x64,windows-x64.exe}
# Usage: scripts/build-agent.sh [version]   (default: the version in packages/agent/package.json)
# Needs bun, and `pnpm install` run first (the workspace protocol package is built here).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-$(node -p "require('./packages/agent/package.json').version")}"
VERSION="${VERSION#v}"
# Semver, as the release workflow's tag filter (v[0-9]+.[0-9]+.[0-9]+*) expects: 1.2.3, 1.2.3-rc.1, 1.2.3+build.
SEMVER='^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]*)?$'
[[ "$VERSION" =~ $SEMVER ]] || { echo "build-agent: not a semver version: $VERSION" >&2; exit 2; }

# bun leaves temporary .bun-build files in the working directory when cross-compiling, even when it fails.
trap 'rm -f ./*.bun-build ./.*.bun-build' EXIT

# The agent imports @hoistline/protocol through its built dist.
pnpm --filter @hoistline/protocol build

mkdir -p dist-bin
for target in darwin-arm64 darwin-x64 linux-x64 windows-x64; do
  out="dist-bin/hoistline-agent-$target"
  [ "$target" = "windows-x64" ] && out="$out.exe"
  echo "build-agent: $out ($VERSION)"
  bun build packages/agent/src/bin.ts --compile --target="bun-$target" \
    --define "HOISTLINE_AGENT_VERSION=\"$VERSION\"" --outfile "$out"
done
