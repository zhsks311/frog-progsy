#!/bin/sh
set -eu

export FROGPROGSY_HOME="${FROGPROGSY_HOME:-/config}"
export FROGP_EXTERNAL_SUPERVISOR="${FROGP_EXTERNAL_SUPERVISOR:-1}"
export FROGP_DOCKER_BIND_HOSTNAME="${FROGP_DOCKER_BIND_HOSTNAME:-0.0.0.0}"

mkdir -p "$FROGPROGSY_HOME"
bun /app/docker/ensure-config.ts

exec "$@"
