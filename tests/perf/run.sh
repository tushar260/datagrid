#!/usr/bin/env bash
# Seeds a scratch DB on the local Postgres (default :5432), runs the resource benchmark, ALWAYS drops the scratch DB.
set -euo pipefail
cd "$(dirname "$0")/../.."
export PERF_PG_PORT="${PERF_PG_PORT:-5432}" PERF_DB="dgl_perf_$RANDOM"
PSQL="psql -h localhost -p $PERF_PG_PORT -U ${PERF_PG_USER:-$(whoami)}"
trap '$PSQL -d postgres -qc "drop database if exists $PERF_DB with (force)" || true' EXIT
$PSQL -d postgres -qc "create database $PERF_DB"
bash tests/perf/seed.sh
node --experimental-strip-types tests/perf/bench.ts
