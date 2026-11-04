#!/usr/bin/env bash
# Our engine under several configurations, on the same four cases: a cached query (HTTP), an uncached query over 64 lists (HTTP), a mutation
# (HTTP) and subscription fan-out (the reactive side: 1,000 WebSockets watching one query while todos are added). One JSON line per run, to
# $R (results-engine.jsonl). Needs `bun run services:up` (or just postgres) for the Postgres runs; pins Postgres to core 2.
#   benchmarks/load/engine-compare.sh                 # SQLite, then Postgres
#   WHICH=sqlite SECONDS_=10 benchmarks/load/engine-compare.sh
set -u
B=$(cd "$(dirname "$0")" && pwd)
R=${R:-$B/results-engine.jsonl}
WHICH=${WHICH:-both}
export SECONDS_=${SECONDS_:-10}
PGURL=postgres://forge:forge@localhost:55432/forge
PG=archlast-forge-postgres-1
psql_() { PGPASSWORD=forge psql -h localhost -p 55432 -U forge -d forge -qAtc "$1" >/dev/null 2>&1; }
case_() { # label cores kind env...
  local label=$1 cores=$2 kind=$3; shift 3
  "$B/case.sh" "$label" "$cores" "$kind" "$@" 2>/dev/null | tee -a "$R"
}
all_cases() { # config-name cores env...
  local name=$1 cores=$2; shift 2
  case_ "$name | cached query"             "$cores" get     "$@"
  case_ "$name | uncached query, 64 lists" "$cores" getmany "$@" CACHE_TTL_MS=0 SEED_LISTS=64
  case_ "$name | mutation"                 "$cores" post    "$@"
  CLIENTS=${CLIENTS:-1000} RATE=${RATE:-10} case_ "$name | fan-out, ${CLIENTS:-1000} subscribers, ${RATE:-10} writes/s" "$cores" fanout "$@" CACHE_TTL_MS=0
}
if [ "$WHICH" != postgres ]; then
  all_cases "sqlite | default" 0-2
  all_cases "sqlite | RUNTIME_WORKERS=2" 0-2 RUNTIME_WORKERS=2
  all_cases "sqlite | RUNTIME_WORKERS=3" 0-2 RUNTIME_WORKERS=3
fi
if [ "$WHICH" != sqlite ]; then
  docker update --cpuset-cpus 2 $PG >/dev/null
  fresh() { psql_ "drop schema public cascade; create schema public"; }
  psql_ "alter system reset all"; docker restart $PG >/dev/null; sleep 6
  fresh; all_cases "postgres | default" 0-1 DATABASE_URL=$PGURL
  fresh; all_cases "postgres | RUNTIME_WORKERS=2" 0-1 DATABASE_URL=$PGURL RUNTIME_WORKERS=2
  psql_ "alter system set shared_buffers='1GB'"; psql_ "alter system set effective_cache_size='4GB'"; psql_ "alter system set random_page_cost=1.1"; psql_ "alter system set jit=off"; psql_ "alter system set wal_compression=on"; psql_ "alter system set max_connections=200"
  docker restart $PG >/dev/null; sleep 6
  fresh; all_cases "postgres | tuned server + RUNTIME_WORKERS=2" 0-1 DATABASE_URL=$PGURL RUNTIME_WORKERS=2
  psql_ "alter system reset all"; docker update --cpuset-cpus 0-3 $PG >/dev/null
fi
echo finished
