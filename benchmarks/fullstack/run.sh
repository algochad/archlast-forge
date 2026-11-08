#!/bin/bash
# Compares archlast-forge, React Router (framework mode, react-router-serve) and Next.js (next start) on the same two pages.
#   cd benchmarks/fullstack && (cd react-router && bun install && node node_modules/@react-router/dev/bin.js build) && (cd next && bun install && node node_modules/next/dist/bin/next build) && ./run.sh
# Each server is pinned to cores 0-3 and loaded from cores 4-7 with oha, 64 connections, 5 s per run, 3 runs (the median is reported); one process each, as shipped.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
SERVER_CPUS=${SERVER_CPUS:-0-3}; CLIENT_CPUS=${CLIENT_CPUS:-4-7}; CONNS=${CONNS:-64}; SECS=${SECS:-5}
OUT=$HERE/results.raw
: > "$OUT.tmp"

median() { sort -n | awk '{a[NR]=$1} END {print a[int((NR+1)/2)]}'; }

# bench <label> <port> <dir> <"VAR=x VAR2=y"> <command...>
bench() {
  local label=$1 port=$2 dir=$3 vars=$4; shift 4
  if curl -s -o /dev/null "localhost:$port/"; then echo "port $port is in use: stop what is there first" >&2; exit 1; fi
  ( cd "$dir" && exec env $vars taskset -c "$SERVER_CPUS" "$@" > "$HERE/.server-$port.log" 2>&1 ) &
  local pid=$!
  for _ in $(seq 1 90); do curl -s -o /dev/null "localhost:$port/" && break; sleep 1; done
  for path in / /products; do
    curl -s -o /dev/null "localhost:$port$path"; curl -s -o /dev/null "localhost:$port$path"
    local rps=() p50=() p99=()
    for _ in 1 2 3; do
      local o; o=$(taskset -c "$CLIENT_CPUS" oha -z "${SECS}s" -c "$CONNS" --no-tui -H "accept-encoding: identity" "http://127.0.0.1:$port$path" 2>&1)
      rps+=("$(echo "$o" | grep 'Requests/sec' | awk '{print $2}')")
      p50+=("$(echo "$o" | grep '50.00%' | awk '{v=$3; if ($4=="sec") v*=1000; else if ($4=="us"||$4=="µs") v/=1000; printf "%.2f", v}')")
      p99+=("$(echo "$o" | grep '99.00%' | awk '{v=$3; if ($4=="sec") v*=1000; else if ($4=="us"||$4=="µs") v/=1000; printf "%.2f", v}')")
      echo "$o" | grep -q "Success rate:.*100.00%" || echo "  (errors in a run of $label $path)" >&2
    done
    local a; a=$(bun "$HERE/assets.ts" "http://127.0.0.1:$port" "$path")
    local rss; rss=$(ps -o rss= -p "$pid" | awk '{printf "%.0f", $1/1024}')
    echo "$label|$path|$(printf '%s\n' "${rps[@]}" | median)|$(printf '%s\n' "${p50[@]}" | median)|$(printf '%s\n' "${p99[@]}" | median)|$rss|$a" >> "$OUT.tmp"
    echo "$label $path rps=$(printf '%s\n' "${rps[@]}" | median) p50=$(printf '%s\n' "${p50[@]}" | median)ms p99=$(printf '%s\n' "${p99[@]}" | median)ms rss=${rss}MB $a"
  done
  kill "$pid" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do curl -s -o /dev/null "localhost:$port/" || break; sleep 1; done
  kill -9 "$pid" 2>/dev/null
}

for FMT in 0 1; do
  export CACHE_INTL=$FMT
  [ "$FMT" = 1 ] && SUFFIX=" [formatters shared]" || SUFFIX=" [formatters per call]"
  bench "archlast-forge (as scaffolded: islands + kept home)$SUFFIX" 3400 "$ROOT" "NODE_ENV=production KEEP=1" bun benchmarks/fullstack/archlast/server.ts
  bench "archlast-forge (islands, home rendered each time)$SUFFIX" 3400 "$ROOT" "NODE_ENV=production KEEP=0" bun benchmarks/fullstack/archlast/server.ts
  bench "archlast-forge (whole-page hydration, like React Router)$SUFFIX" 3400 "$ROOT" "NODE_ENV=production KEEP=0 ISLANDS=0" bun benchmarks/fullstack/archlast/server.ts
  bench "React Router 7 (react-router-serve, Node)$SUFFIX" 3500 "$HERE/react-router" "NODE_ENV=production PORT=3500" node node_modules/@react-router/serve/dist/cli.js ./build/server/index.js
  bench "Next.js 16 (next start, Node)$SUFFIX" 3300 "$HERE/next" "NODE_ENV=production" node node_modules/next/dist/bin/next start -p 3300
done
mv "$OUT.tmp" "$OUT"
