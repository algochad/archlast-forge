#!/usr/bin/env bash
# Postgres + Redis (both pinned to core 2), one and two replicas; and the cost of cache invalidation on writes.
cd "$(dirname "$0")"
R=${R:-results2.jsonl}
c() { ./case.sh "$@" >> $R 2>> errors.log; tail -1 $R | cut -c1-160; }
export SECONDS_=15
PG=${TEST_POSTGRES_URL:-postgres://forge:forge@localhost:55432/forge} # bun run services:up
RD=${TEST_REDIS_URL:-redis://localhost:56379}
for rep in 1 2; do
  c "pg 1 replica uncached r$rep" 0 get CACHE_TTL_MS=0 DATABASE_URL=$PG REDIS_URL=$RD
  c "pg 1 replica mutation r$rep" 0 post CACHE_TTL_MS=0 DATABASE_URL=$PG REDIS_URL=$RD
  SECOND_CORES=1 c "pg 2 replicas uncached r$rep" 0 get CACHE_TTL_MS=0 DATABASE_URL=$PG REDIS_URL=$RD REPLICAS=2
  SECOND_CORES=1 c "pg 2 replicas mutation r$rep" 0 post CACHE_TTL_MS=0 DATABASE_URL=$PG REDIS_URL=$RD REPLICAS=2
  # Invalidation: each todos write publishes 5 topics; with the cache on, each is also evicted (memory: a map lookup; Redis: round trips).
  c "sqlite mutation cache-on (memory) r$rep" 0 post CACHE_TTL_MS=60000
  c "pg mutation cache-on (redis) r$rep" 0 post CACHE_TTL_MS=60000 DATABASE_URL=$PG REDIS_URL=$RD
done
echo DONE
