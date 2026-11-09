// Gathers the benchmarks' results.json files and this machine's description into apps/docs/src/bench.json, which the docs site's landing page and
// benchmarks page read. Run after rest/run.sh, pool/run.sh and fullstack/run.sh (+ report.ts in each):  bun benchmarks/collect.ts
import { readFileSync, writeFileSync } from "node:fs";
import { cpus, release, totalmem } from "node:os";

const read = (path: string) => JSON.parse(readFileSync(`${import.meta.dir}/${path}`, "utf8"));
const sh = (cmd: string) => Bun.spawnSync(["bash", "-c", cmd]).stdout.toString().trim();

const out = {
  date: new Date().toISOString().slice(0, 10),
  machine: {
    cpu: cpus()[0]!.model.replace(/\(R\)|\(TM\)/g, "").replace(/\s+/g, " ").trim(),
    cores: Number(sh("lscpu -p=CORE | grep -v '^#' | sort -u | wc -l")),
    threads: cpus().length,
    memoryGiB: Math.round(totalmem() / 2 ** 30),
    kernel: release(),
    governor: sh("cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null") || "unknown",
    docker: sh("docker version --format '{{.Server.Version}}'"),
    oha: sh("oha --version").replace("oha ", ""),
  },
  limits: { serverCpus: "0-3", serverThreads: 4, serverMemory: "2 GiB", swap: "none", clientCpus: "4-7", clientThreads: 4, connections: 64, secs: 10 },
  versions: {
    node: sh("docker run --rm --entrypoint node bench-rest-express --version").replace(/^v/, ""),
    nodeForFullstack: sh("node --version").replace(/^v/, ""),
    bun: sh("docker run --rm --entrypoint bun bench-rest-bun --version"),
    go: sh("docker run --rm --entrypoint go golang:1.24-alpine version").replace(/^go version go(\S+).*/, "$1"),
    dotnet: sh("docker run --rm --entrypoint dotnet bench-rest-dotnet --list-runtimes | grep AspNetCore | awk '{print $2}'"),
    rust: sh("docker run --rm rust:1.90-bookworm rustc --version").split(" ")[1],
    express: read("rest/servers/express/package.json").dependencies.express,
    fasthttp: /valyala\/fasthttp v([\d.]+)/.exec(readFileSync(`${import.meta.dir}/rest/servers/go/go.mod`, "utf8"))![1],
    sqlite: sh("docker run --rm --entrypoint bun bench-rest-bun -e 'import {Database} from \"bun:sqlite\"; console.log(new Database(\":memory:\").query(\"select sqlite_version() v\").get().v)'"),
    axum: /^axum = "([\d.]+)"/m.exec(readFileSync(`${import.meta.dir}/rest/servers/axum/Cargo.toml`, "utf8"))![1],
    next: read("fullstack/next/node_modules/next/package.json").version,
    reactRouter: read("fullstack/react-router/node_modules/react-router/package.json").version,
    brust: read("fullstack/brust/node_modules/@brust/core/package.json").version,
  },
  rest: read("rest/results.json"),
  restSqlite: read("rest/results-sqlite.json"),
  pool: read("pool/results.json"),
  fullstack: read("fullstack/results.json"),
};
writeFileSync(`${import.meta.dir}/../apps/docs/src/bench.json`, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ machine: out.machine, versions: out.versions }, null, 2));
