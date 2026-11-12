#!/usr/bin/env bash
# Start the SessionHub remote agent from the repository root.
cd "$(dirname "$0")/.." || exit 1
exec node agent/agent.js
