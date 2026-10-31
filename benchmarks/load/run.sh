#!/usr/bin/env bash
# The single-server matrix (SQLite): saturation, open loop and fan-out. Results as JSON lines in $R (results.jsonl).
cd "$(dirname "$0")"
R=${R:-results.jsonl}
c() { ./case.sh "$@" >> $R 2>> errors.log; tail -1 $R | cut -c1-160; }
export SECONDS_=15
for rep in 1 2; do
  # Saturation, closed loop, 64 connections: one core inline, then process mode with 1-3 workers on three cores.
  c "sat inline cached r$rep" 0 get CACHE_TTL_MS=60000
  c "sat inline uncached r$rep" 0 get CACHE_TTL_MS=0
  c "sat inline mutation r$rep" 0 post CACHE_TTL_MS=0
  c "sat inline(3 cores) uncached r$rep" 0-2 get CACHE_TTL_MS=0
  c "sat inline distinct uncached r$rep" 0 getmany CACHE_TTL_MS=0 SEED_LISTS=64
  for w in 1 2 3; do
    c "sat process w$w uncached r$rep" 0-2 get CACHE_TTL_MS=0 RUNTIME_MODE=process RUNTIME_WORKERS=$w
    c "sat process w$w mutation r$rep" 0-2 post CACHE_TTL_MS=0 RUNTIME_MODE=process RUNTIME_WORKERS=$w
    c "sat process w$w distinct uncached r$rep" 0-2 getmany CACHE_TTL_MS=0 SEED_LISTS=64 RUNTIME_MODE=process RUNTIME_WORKERS=$w
  done
done
# Open loop at fixed rates, one core inline: latency and loop delay below saturation.
for rate in 1000 2000 3000; do RATE=$rate c "open inline uncached ${rate}/s" 0 get CACHE_TTL_MS=0; done
for rate in 5000 10000; do RATE=$rate c "open inline cached ${rate}/s" 0 get CACHE_TTL_MS=60000; done
RATE=500 c "open inline mutation 500/s" 0 post CACHE_TTL_MS=0
# Fan-out: clients on one query, 10 writes a second.
for n in 200 1000; do
  CLIENTS=$n RATE=10 c "fanout $n cache-on" 0 fanout CACHE_TTL_MS=60000
  CLIENTS=$n RATE=10 c "fanout $n cache-off" 0 fanout CACHE_TTL_MS=0
done
echo DONE
