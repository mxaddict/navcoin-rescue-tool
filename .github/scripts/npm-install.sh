#!/usr/bin/env bash
# Runs `npm install`, retrying when it fails. Native dependencies fetch
# prebuilt binaries over the network during install (canvas from its
# GitHub release, for one), and a single failed fetch otherwise fails the
# job and skips everything gated on it.
set -euo pipefail

MAX_ATTEMPTS=3
RETRY_DELAY_SECONDS=30

attempt=1
until npm install; do
  if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
    echo "npm install failed after $attempt attempts" >&2
    exit 1
  fi
  echo "npm install failed (attempt $attempt of $MAX_ATTEMPTS); retrying in ${RETRY_DELAY_SECONDS}s" >&2
  sleep "$RETRY_DELAY_SECONDS"
  attempt=$((attempt + 1))
done
