#!/usr/bin/env bash
# The same workload on SQLite, Postgres (defaults, then tuned) and MongoDB, one after another. Needs Docker for the servers:
#   docker compose up -d --wait postgres mongo      (mongo: see docker-compose.yml)
# SCALE=0.5 SECONDS=3 benchmarks/db-adapters/run-all.sh
set -u
cd "$(dirname "$0")/../.."
OUT=benchmarks/db-adapters/results
SCALE=${SCALE:-0.5}
PGURL=postgres://forge:forge@localhost:55432/forge
psql_() { PGPASSWORD=forge psql -h localhost -p 55432 -U forge -d forge -qAtc "$1"; }
run() { echo "== $1"; DB=$2 SCALE=$SCALE SECONDS=${SECONDS_PER:-3} JSON=$OUT/$1.json "${@:3}" bun benchmarks/db-adapters/bench.ts 2>&1 | grep -v Warning; }

run sqlite sqlite env
# Postgres as it comes
psql_ "alter system reset all" >/dev/null; docker restart archlast-forge-postgres-1 >/dev/null; sleep 6
run postgres-default postgres env
# Postgres tuned: settings that cost no durability, and a bigger write pool
psql_ "alter system set shared_buffers = '1GB'" >/dev/null
psql_ "alter system set effective_cache_size = '4GB'" >/dev/null
psql_ "alter system set random_page_cost = 1.1" >/dev/null
psql_ "alter system set jit = off" >/dev/null
psql_ "alter system set wal_compression = on" >/dev/null
psql_ "alter system set max_connections = 200" >/dev/null
docker restart archlast-forge-postgres-1 >/dev/null; sleep 6
run postgres-tuned postgres env POOL=8
psql_ "alter system reset all" >/dev/null
run mongodb mongodb env
