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
[[ "$VERSION" =~ ^[0-9A-Za-z.+-]+$ ]] || { echo "build-agent: bad version: $VERSION" >&2; exit 2; }

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
# bun leaves temporary .bun-build files in the working directory when cross-compiling.
rm -f ./*.bun-build ./.*.bun-build
