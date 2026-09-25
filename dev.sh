#!/usr/bin/env bash
# Launch the Next.js dev server for build-supabase on Termux.
#
# Why not `npm run dev`? On Termux Android (ARM64):
#   1. `next` binary isn't on PATH for npm scripts in some setups.
#   2. Turbopack has no native bindings for android/arm64 -> must use webpack.
# This script uses the full path to the next binary and forces webpack.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

echo "Starting build-supabase dev server (webpack) → http://localhost:3000"
node node_modules/next/dist/bin/next dev --webpack
