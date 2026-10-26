#!/bin/sh
# Pre-commit entry point for Balk2 (see README, "Pre-commit").
# Runs the pinned Balk2 release through npx, so the hook needs Node 18 or later and npm on the PATH.
# Arguments pass through: none for the balk2 hook (regenerates the map), `check` for balk2-check.
# BALK2_SPEC overrides the pinned package, for testing a local tarball.
set -e
exec npx --yes --package "${BALK2_SPEC:-@lumenspero/balk2@2.0.1}" balk2 "$@"
