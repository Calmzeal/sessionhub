#!/usr/bin/env bash
# Start the SessionHub hub server from the repository root.
cd "$(dirname "$0")/.." || exit 1
exec node server/index.js
