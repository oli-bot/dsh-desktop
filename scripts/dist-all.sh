#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> [0/5] Building web..."
node scripts/build.mjs

echo "==> [0/5] Building DSH runtime..."
node scripts/build-dsh.mjs

# ── Mac arm64 ────────────────────────────────────────────────────────
echo "==> [1/4] Mac arm64 – staging..."
DEEPWORK_NODE_PLATFORM=darwin DEEPWORK_NODE_ARCH=arm64 node scripts/stage-dsh.mjs
echo "==> [1/4] Mac arm64 – building..."
DEEPWORK_MAC_ARCH=arm64 node scripts/build-mac.mjs

# ── Mac x64 ──────────────────────────────────────────────────────────
echo "==> [2/4] Mac x64 – staging..."
DEEPWORK_NODE_PLATFORM=darwin DEEPWORK_NODE_ARCH=x64 node scripts/stage-dsh.mjs
echo "==> [2/4] Mac x64 – building..."
DEEPWORK_MAC_ARCH=x64 node scripts/build-mac.mjs

# ── Win x64 ──────────────────────────────────────────────────────────
echo "==> [3/4] Win x64 – staging..."
DEEPWORK_NODE_PLATFORM=win DEEPWORK_NODE_ARCH=x64 node scripts/stage-dsh.mjs
echo "==> [3/4] Win x64 – building..."
DEEPWORK_WIN_ARCH=x64 node scripts/build-win.mjs

# ── Win arm64 ────────────────────────────────────────────────────────
echo "==> [4/4] Win arm64 – staging..."
DEEPWORK_NODE_PLATFORM=win DEEPWORK_NODE_ARCH=arm64 node scripts/stage-dsh.mjs
echo "==> [4/4] Win arm64 – building..."
DEEPWORK_WIN_ARCH=arm64 node scripts/build-win.mjs

echo ""
echo "==> All done! Release artifacts:"
ls -lh release/
