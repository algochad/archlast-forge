#!/bin/bash
# The benchmark's CRUD API in six stacks, each in a container with the same limits, loaded with oha from outside.
#   ./run.sh [server...]        servers: axum go dotnet bun node nest-node nest-bun serve forge forge-minimal forge-bun forge-notelemetry   (default: all; a run of some servers keeps the others' results)
#   env: SERVER_CPUS (0-3)  SERVER_MEM (2g)  CLIENT_CPUS (4-7,12-15)  CONNS (64)  SECS (5)  RUNS (3)
# Builds the images first (docker build, context: this folder), checks each server with conformance.ts, then for each scenario warms up for 2 s and
# measures RUNS runs of SECS seconds: requests/s, latency, the CPU the container used (cgroup cpu.stat) and its peak memory (memory.peak).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
SERVER_CPUS=${SERVER_CPUS:-0-3}; SERVER_MEM=${SERVER_MEM:-2g}; CLIENT_CPUS=${CLIENT_CPUS:-4-7,12-15}
CONNS=${CONNS:-64}; SECS=${SECS:-5}; RUNS=${RUNS:-3}; PORT=4600
OUT=$HERE/results.raw
TMP=${TMPDIR:-/tmp}/rest-bench.$$; mkdir -p "$TMP"
BODY='{"name":"widget","quantity":7}'
# (SERVER_PROCESSES=1: the items live in the memory of one process, which a cluster of servers would split in two)
FORGE_ENV=(-e RATE_LIMIT_PER_MINUTE=0 -e BETTER_AUTH_SECRET=ssssssssssssssssssssssssssssssss -e ALLOW_INSECURE_HTTP=1 -e SERVER_PROCESSES=1 --tmpfs /data:rw,uid=1000,gid=1000,size=256m)

# name | image | url prefix | docker arguments
declare -A IMAGE PREFIX ARGS LABEL
def() { IMAGE[$1]=$2; PREFIX[$1]=$3; ARGS[$1]=$4; LABEL[$1]=$5; }
def axum bench-rest-axum "" "" "Rust (Axum 0.8, Tokio)"
def go bench-rest-go "" "" "Go (fasthttp)"
def dotnet bench-rest-dotnet "" "" ".NET 10 (Minimal APIs)"
def dotnet-webapi bench-rest-dotnet-webapi "" "-e STORE=memory" ".NET 10 (Web API: controllers and middleware)"
def dotnet-controllers bench-rest-dotnet-webapi "" "-e STORE=memory -e PIPELINE=controllers" ".NET 10 (Web API: controllers only, no middleware)"
def bun bench-rest-bun "" "" "Bun.serve"
def nest-node bench-rest-nest-node "" "" "NestJS on Node.js 24 (Express adapter)"
def nest-bun bench-rest-nest-bun "" "" "NestJS on Bun (Express adapter)"
def serve bench-rest-tuyere "" "-e THREADS=3" "Tuyere (native App API, 3 I/O threads)"
def nest-serve bench-rest-nest-serve "" "-e THREADS=3" "NestJS on Tuyere (no Forge, a basic adapter)"
def node bench-rest-express "" "" "Node.js 24 (Express 5)"
def forge bench-rest-forge /http "${FORGE_ENV[*]}" "archlast-forge (NestJS path, Tuyere)"
def forge-minimal bench-rest-forge-minimal /http "${FORGE_ENV[*]}" "archlast-forge (forge/http.ts minimal routes, Tuyere)"
def forge-bun bench-rest-forge /http "${FORGE_ENV[*]} -e HTTP_ENGINE=bun" "archlast-forge (NestJS path, Bun.serve)"
def forge-notelemetry bench-rest-forge /http "${FORGE_ENV[*]} -e TELEMETRY=off" "archlast-forge (NestJS path, Tuyere, telemetry off)"
SERVERS=${*:-axum go dotnet bun node nest-node nest-bun serve nest-serve forge forge-minimal forge-bun forge-notelemetry}

build() {
  for s in axum go dotnet dotnet-webapi bun express nest-node nest-bun tuyere nest-serve forge forge-minimal; do
    docker image inspect bench-rest-$s >/dev/null 2>&1 || docker build -q -f "$HERE/servers/$s/Dockerfile" -t bench-rest-$s "$HERE" >/dev/null || exit 1
  done
}

# SUITE=sqlite: the same API and scenarios with the items in SQLite (a file on tmpfs, WAL). Each server's own driver, and the Forge rows on ctx.db; results go to results-sqlite.raw.
SEEDED=" "
if [ "${SUITE:-memory}" = sqlite ]; then
  # The database is a file in a fresh directory of this disk (bind-mounted at /data), not tmpfs: Forge's write-ahead log grows to gigabytes during the create case (see README.md)
  SQLITE_ENV=(-e RATE_LIMIT_PER_MINUTE=0 -e BETTER_AUTH_SECRET=ssssssssssssssssssssssssssssssss -e ALLOW_INSECURE_HTTP=1 -e SQLITE_SYNCHRONOUS=NORMAL)
  DATA_ROOT=${BENCH_DATA:-$HERE/.bench-data}; mkdir -p "$DATA_ROOT"
  def axum bench-rest-sqlite-axum "" "" "Rust (Axum 0.8, Tokio, rusqlite)"
  def go bench-rest-sqlite-go "" "" "Go (fasthttp, go-sqlite3)"
  def dotnet bench-rest-sqlite-dotnet "" "" ".NET 10 (Minimal APIs, Microsoft.Data.Sqlite)"
  def dotnet-webapi bench-rest-sqlite-dotnet-webapi "" "-e STORE=sqlite" ".NET 10 (Web API: controllers and middleware, Microsoft.Data.Sqlite)"
  def dotnet-controllers bench-rest-sqlite-dotnet-webapi "" "-e STORE=sqlite -e PIPELINE=controllers" ".NET 10 (Web API: controllers only, no middleware, Microsoft.Data.Sqlite)"
  def bun bench-rest-sqlite-bun "" "" "Bun.serve (bun:sqlite)"
  def node bench-rest-sqlite-node "" "" "Node.js 24 (Express 5, node:sqlite)"
  def nest-node bench-rest-sqlite-nest-node "" "" "NestJS on Node.js 24 (Express adapter, node:sqlite)"
  def nest-bun bench-rest-sqlite-nest-bun "" "" "NestJS on Bun (Express adapter, bun:sqlite)"
  def serve bench-rest-sqlite-serve "" "-e THREADS=3" "Tuyere (native App API, 3 I/O threads, bun:sqlite)"
  def nest-serve bench-rest-sqlite-nest-serve "" "-e THREADS=3" "NestJS on Tuyere (no Forge, a basic adapter, bun:sqlite)"
  def forge bench-rest-sqlite-forge /http "${SQLITE_ENV[*]}" "archlast-forge (NestJS path, Tuyere, ctx.db)"
  def forge-minimal bench-rest-sqlite-forge-minimal /http "${SQLITE_ENV[*]}" "archlast-forge (forge/http.ts minimal routes, Tuyere, ctx.db)"
  def forge-bun bench-rest-sqlite-forge /http "${SQLITE_ENV[*]} -e HTTP_ENGINE=bun" "archlast-forge (NestJS path, Bun.serve, ctx.db)"
  def forge-notelemetry bench-rest-sqlite-forge /http "${SQLITE_ENV[*]} -e TELEMETRY=off" "archlast-forge (NestJS path, Tuyere, telemetry off, ctx.db)"
  def forge-bunsqlite bench-rest-sqlite-forge-bunsqlite /http "${SQLITE_ENV[*]}" "archlast-forge (NestJS path, Tuyere, bun:sqlite)"
  def forge-minimal-bunsqlite bench-rest-sqlite-forge-minimal-bunsqlite /http "${SQLITE_ENV[*]}" "archlast-forge (forge/http.ts minimal routes, Tuyere, bun:sqlite)"
  [ $# -eq 0 ] && SERVERS="$SERVERS forge-bunsqlite forge-minimal-bunsqlite"   # the Forge routes on the same bun:sqlite store as the other JavaScript servers, beside the rows on the engine's own database
  SEEDED=" forge forge-minimal forge-bun forge-notelemetry "   # the Forge rows start with an empty database: the harness seeds it (items 1 to 1000) through POST /seed
  OUT=$HERE/results-sqlite.raw
  build() {
    local name dockerfile
    for pair in axum:axum/Dockerfile go:go/Dockerfile dotnet:dotnet/Dockerfile dotnet-webapi:dotnet-webapi/Dockerfile bun:bun/Dockerfile.sqlite node:express/Dockerfile.sqlite nest-node:nest-node/Dockerfile.sqlite nest-bun:nest-bun/Dockerfile.sqlite serve:tuyere/Dockerfile.sqlite nest-serve:nest-serve/Dockerfile.sqlite forge:forge-sqlite/Dockerfile forge-minimal:forge-minimal-sqlite/Dockerfile forge-bunsqlite:forge/Dockerfile.sqlite forge-minimal-bunsqlite:forge-minimal/Dockerfile.sqlite; do
      name=${pair%%:*}; dockerfile=${pair#*:}
      case $name in axum|go|dotnet) dockerfile=${dockerfile%/Dockerfile}-sqlite/Dockerfile ;; esac
      docker image inspect bench-rest-sqlite-$name >/dev/null 2>&1 || docker build -q -f "$HERE/servers/$dockerfile" -t bench-rest-sqlite-$name "$HERE" >/dev/null || exit 1
    done
  }
fi
[ "${SKIP_BUILD:-0}" = 1 ] || build

# A server's container; in the sqlite suite with a fresh directory of this disk as /data (world-writable: the images run as different users).
DATA=""
start_server() {
  local vol=()
  if [ -n "${DATA_ROOT:-}" ]; then DATA=$(mktemp -d "$DATA_ROOT/db.XXXXXX"); chmod 777 "$DATA"; vol=(-v "$DATA:/data"); fi
  cid=$(docker run -d --rm --network host --cpuset-cpus="$SERVER_CPUS" --memory="$SERVER_MEM" --memory-swap="$SERVER_MEM" -e PORT=$PORT ${ARGS[$name]} "${vol[@]}" ${IMAGE[$name]})
  # memory.peak counts the page cache, and Forge's log file (gigabytes in the create case) fills it: in the sqlite suite the peak is the largest "anon" in memory.stat, sampled every 0.2 s
  if [ -n "${DATA_ROOT:-}" ]; then
    echo 0 > "$TMP/anon"
    ( m=0; while a=$(awk '$1=="anon"{print $2}' "/sys/fs/cgroup/system.slice/docker-$cid.scope/memory.stat" 2>/dev/null) && [ -n "$a" ]; do [ "$a" -gt "$m" ] && { m=$a; echo $m > "$TMP/anon"; }; sleep 0.2; done ) &
  fi
}
# Stops it and removes its data (written by the container's user, so removed from a container).
stop_server() {
  docker stop -t 1 "$cid" >/dev/null
  [ -n "$DATA" ] && { docker run --rm -v "$DATA:/d" alpine sh -c 'rm -rf /d/* /d/.[!.]*' >/dev/null 2>&1; rmdir "$DATA" 2>/dev/null; DATA=""; }
  return 0
}

cpu_usec() { awk '/^usage_usec/ {print $2}' "/sys/fs/cgroup/system.slice/docker-$1.scope/cpu.stat"; }
oha() { taskset -c "$CLIENT_CPUS" oha --no-tui -c "$CONNS" "$@"; }

: > "$OUT.tmp"
for name in $SERVERS; do
  PORT=$((PORT+1)); pre=${PREFIX[$name]}
  start_server
  for _ in $(seq 1 120); do curl -s -o /dev/null "localhost:$PORT$pre/items/1" && break; sleep 0.5; done
  [[ "$SEEDED" == *" $name "* ]] && curl -s -o /dev/null -X POST "localhost:$PORT$pre/seed"
  if ! bun "$HERE/conformance.ts" "http://127.0.0.1:$PORT" "$pre" >"$TMP/conf.log" 2>&1; then echo "$name does not conform:"; grep ✗ "$TMP/conf.log"; stop_server; continue; fi
  # the conformance run changed items 2 and 3; start the measurements from a fresh server
  stop_server; sleep 1
  start_server
  for _ in $(seq 1 120); do curl -s -o /dev/null "localhost:$PORT$pre/items/1" && break; sleep 0.5; done
  [[ "$SEEDED" == *" $name "* ]] && curl -s -o /dev/null -X POST "localhost:$PORT$pre/seed"
  base="http://127.0.0.1:$PORT$pre"
  # scenario | oha arguments
  while IFS='|' read -r scenario args; do
    eval "set -- $args"
    oha -z 2s "$@" >/dev/null 2>&1
    for run in $(seq 1 "$RUNS"); do
      u0=$(cpu_usec "$cid")
      oha -z "${SECS}s" --output-format json "$@" 2>/dev/null > "$TMP/oha.json"
      u1=$(cpu_usec "$cid")
      bun -e '
        const j = JSON.parse(await Bun.file(process.argv[1]).text());
        const [name, scenario, run, u0, u1, secs] = process.argv.slice(2);
        const ok = Object.entries(j.statusCodeDistribution).filter(([c]) => c.startsWith("2")).reduce((a, [, n]) => a + Number(n), 0);
        const total = Object.values(j.statusCodeDistribution).reduce((a, n) => a + Number(n), 0);
        const rps = j.summary.requestsPerSec;
        console.log(JSON.stringify({ name, scenario, run: Number(run), rps, p50ms: j.latencyPercentiles.p50 * 1000, p99ms: j.latencyPercentiles.p99 * 1000, success: ok / total, cores: (u1 - u0) / 1e6 / Number(secs) }));
      ' "$TMP/oha.json" "$name" "$scenario" "$run" "$u0" "$u1" "$SECS" >> "$OUT.tmp"
    done
    tail -n "$RUNS" "$OUT.tmp" | bun -e 'const rows = (await Bun.stdin.text()).trim().split("\n").map((l) => JSON.parse(l)).sort((a, b) => a.rps - b.rps); const m = rows[Math.floor(rows.length / 2)]; console.log(`${m.name.padEnd(18)} ${m.scenario.padEnd(7)} ${String(Math.round(m.rps)).padStart(8)} req/s  p50 ${m.p50ms.toFixed(2)} ms  p99 ${m.p99ms.toFixed(2)} ms  ${m.cores.toFixed(2)} cores  ok ${(m.success * 100).toFixed(1)}%`)'
  done <<SCENARIOS
read|--rand-regex-url '$base/items/([1-9][0-9]{0,2})'
list|'$base/items?limit=20'
update|-m PUT -H 'content-type: application/json' -d '$BODY' --rand-regex-url '$base/items/([1-9][0-9]{0,2})'
create|-m POST -H 'content-type: application/json' -d '$BODY' '$base/items'
SCENARIOS
  if [ -n "${DATA_ROOT:-}" ]; then peak=$(awk '{printf "%.0f", $1/1048576}' "$TMP/anon")
  else peak=$(awk '{printf "%.0f", $1/1048576}' "/sys/fs/cgroup/system.slice/docker-$cid.scope/memory.peak"); fi
  echo "{\"name\":\"$name\",\"scenario\":\"_memory\",\"peakMiB\":$peak}" >> "$OUT.tmp"
  echo "$name peak memory ${peak} MiB"
  stop_server; sleep 1
done
# a run of some servers keeps the results of the others
if [ -s "$OUT" ]; then
  keep=$(cat "$OUT"); for name in $SERVERS; do keep=$(printf '%s\n' "$keep" | grep -v "\"name\":\"$name\"" || true); done
  { printf '%s\n' "$keep" | grep -v '^$'; cat "$OUT.tmp"; } > "$OUT.new" && mv "$OUT.new" "$OUT"; rm -f "$OUT.tmp"
else mv "$OUT.tmp" "$OUT"; fi
rm -rf "$TMP"
