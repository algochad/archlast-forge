import { type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router";
import { Code } from "./Code";
import { Anvil } from "./Anvil";
import { Arrow } from "./icons";
import bench from "./bench.json";

/** The measured numbers for the landing page's speed section. They come from benchmarks/ (see the benchmarks page), through `bench.json`. */

const k = (n: number) => Math.round(n).toLocaleString("en-US");
const x = (a: number, b: number) => `${a / b >= 10 ? Math.round(a / b) : (a / b).toFixed(1)}×`;
const ms = (n: number) => (n >= 100 ? `${Math.round(n)} ms` : n >= 10 ? `${n.toFixed(1)} ms` : `${n.toFixed(2)} ms`);

interface BarRow { label: string; value: number; us?: boolean }

/** Horizontal bars that grow when the chart scrolls into view (the page's [data-reveal] adds .in). `log` draws the length by the number's logarithm, for a range of 1,000 to 1. */
function Bars({ title, rows: given, log = false, note, unit = "req/s" }: { title: string; rows: BarRow[]; log?: boolean; note?: ReactNode; unit?: string }) {
  const rows = [...given].sort((a, b) => b.value - a.value); // highest first, whatever order the rows were written in
  const max = rows[0]!.value;
  const width = (v: number) => (log ? (Math.log10(v) / Math.log10(max)) * 100 : (v / max) * 100);
  return (
    <div className="chart" data-reveal>
      <h4>{title}</h4>
      <div className="bars">
        {rows.map((r, i) => (
          <div className={r.us ? "bar us" : "bar"} key={r.label} style={{ "--i": i } as CSSProperties}>
            <span title={r.label}>{r.label}</span>
            <span className="track"><span className="fill" style={{ "--w": Math.max(width(r.value), 0.6) } as CSSProperties} /></span>
            <b>{k(r.value)}</b>
          </div>
        ))}
      </div>
      {note && <p className="note">{note} <i>({unit}{log ? ", log scale" : ""})</i></p>}
    </div>
  );
}

const rest = bench.rest as Record<string, { scenarios: Record<string, { rps: number; p99ms: number }>; peakMiB: number }>;
const restSqlite = bench.restSqlite as typeof rest;
const fs = bench.fullstack as Record<string, Record<string, Record<string, { rps: number }>>>;
const pool = bench.pool;

const fsRow = (variant: "shared" | "perCall", path: string, match: RegExp) => {
  const rows = fs[variant]![path]!;
  const key = Object.keys(rows).find((n) => match.test(n))!;
  return rows[key]!.rps;
};
const home = (m: RegExp) => fsRow("perCall", "/", m);
const products = (m: RegExp) => fsRow("shared", "/products", m);

export function Env() {
  const m = bench.machine;
  return (
    <p className="env" data-reveal>
      <span>Measured on a <b>{m.cpu}</b>, {m.memoryGiB} GiB</span>
      <span>every server limited to <b>4 CPU cores and 2 GiB</b> of memory</span>
      <span>load by <b>oha</b> {m.oha} from 4 other threads, 64 connections</span>
      <span>median of 3 runs of 10 s · {bench.date}</span>
    </p>
  );
}

export function Perf({ pool: poolSnippet }: { pool: Parameters<typeof Code>[0] }) {
  const read = (n: string) => rest[n]!.scenarios.read!.rps;
  const sql = (n: string) => restSqlite[n]!.scenarios.read!.rps;
  return (
    <>
      <div className="perf">
        <div data-reveal>
          <span className="label">Tuyere</span>
          <h3>A Rust HTTP engine in place of Bun.serve</h3>
          <p>Sockets, TLS, HTTP/1.1, HTTP/2, WebSockets and fan-out run on Rust threads. Your functions stay TypeScript on Bun. It is on by default in production, and nothing in your code changes.</p>
          <div className="big">
            <div><b>{x(read("forge"), read("forge-bun"))}</b><span>the same NestJS controller, against Bun.serve</span></div>
            <div><b>{x(read("forge-minimal"), read("bun"))}</b><span>a Forge minimal route against Bun.serve</span></div>
            <div><b>{x(read("forge"), read("node"))}</b><span>a NestJS controller against Express</span></div>
            <div><b>{x(read("serve"), read("bun"))}</b><span>Tuyere on its own, against Bun.serve</span></div>
          </div>
          <ul className="points">
            <li><b>The engine alone is level with the compiled servers</b> ({k(read("serve"))} req/s, TypeScript handler). The framework around it costs: a Forge minimal route does {k(read("forge-minimal"))}, a NestJS controller {k(read("forge"))}; .NET does {k(read("dotnet"))}.</li>
            <li><b>NestJS on Tuyere alone</b> (a basic adapter, no Forge) does {k(read("nest-serve"))} req/s, {x(read("nest-serve"), read("nest-bun"))} NestJS on Bun and {x(read("nest-serve"), read("forge"))} the Forge Nest path: the difference to Forge is what it adds around every request.</li>
            <li><b>With the items in SQLite</b>, Tuyere alone does {k(sql("serve"))} reads a second (Axum {k(sql("axum"))}, .NET {k(sql("dotnet"))}). Forge through <code>ctx.db</code> does {k(sql("forge-minimal"))} on a minimal route and {k(sql("forge"))} on the Nest path; on <code>bun:sqlite</code> the Nest path does {k(sql("forge-bunsqlite"))}. These are the production setup: Hearth, the native database layer, on two Bellows servers. <code>ctx.db</code> adds schema checks, indexes, transactions and reactivity.</li>
            <li><b>.NET with comparable work.</b> A Web API with controllers and the middleware a service carries (request ids, security headers, telemetry, a rate limiter) does {k(read("dotnet-webapi"))} reads a second in memory and {k(sql("dotnet-webapi"))} on SQLite, {k(read("dotnet-controllers"))} and {k(sql("dotnet-controllers"))} with controllers alone, against {k(read("dotnet"))} and {k(sql("dotnet"))} as Minimal APIs. Forge's NestJS path does {k(read("forge"))} and {k(sql("forge"))}. <Link to="/benchmarks#what-a-net-web-api-costs">What it costs and why it was measured</Link></li>
            <li><b>Where it loses:</b> one connection at a time, and about 1.5× the CPU of Bun.serve per request.</li>
          </ul>
          <Link className="btn link" to="/Tuyere">How the engine works <Arrow /></Link>
        </div>
        <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
          <Bars
            title="GET /items/:id · in-memory CRUD API"
            rows={[
              { label: "Rust · Axum", value: read("axum") },
              { label: "Tuyere · alone", value: read("serve"), us: true },
              { label: "Go · fasthttp", value: read("go") },
              { label: ".NET 10 · Minimal API", value: read("dotnet") },
              { label: ".NET 10 · Web API, controllers only", value: read("dotnet-controllers") },
              { label: ".NET 10 · Web API, with middleware", value: read("dotnet-webapi") },
              { label: "Forge · minimal route", value: read("forge-minimal"), us: true },
              { label: "NestJS · Tuyere, no Forge", value: read("nest-serve"), us: true },
              { label: "Bun.serve", value: read("bun") },
              { label: "NestJS · Bun", value: read("nest-bun") },
              { label: "NestJS · Node", value: read("nest-node") },
              { label: "Forge · Tuyere", value: read("forge"), us: true },
              { label: "Node · Express", value: read("node") },
              { label: "Forge · on Bun.serve", value: read("forge-bun"), us: true },
            ]}
            note={<>4 CPU cores, 2 GiB. <Link to="/benchmarks">Method and all four operations</Link></>}
          />
          <Bars
            title="GET /items/:id · the same API on SQLite"
            rows={[
              { label: "Tuyere · alone", value: sql("serve"), us: true },
              { label: "Rust · Axum", value: sql("axum") },
              { label: "NestJS · Tuyere, no Forge", value: sql("nest-serve"), us: true },
              { label: ".NET 10 · Minimal API", value: sql("dotnet") },
              { label: ".NET 10 · Web API, controllers only", value: sql("dotnet-controllers") },
              { label: ".NET 10 · Web API, with middleware", value: sql("dotnet-webapi") },
              { label: "Go · fasthttp", value: sql("go") },
              { label: "Forge · Nest · bun:sqlite", value: sql("forge-bunsqlite"), us: true },
              { label: "Bun.serve", value: sql("bun") },
              { label: "Forge · minimal route · ctx.db", value: sql("forge-minimal"), us: true },
              { label: "Forge · Nest · ctx.db", value: sql("forge"), us: true },
              { label: "NestJS · Node", value: sql("nest-node") },
            ]}
            note={<>Each in its own SQLite driver; Forge in production (two servers), through <code>ctx.db</code> and through <code>bun:sqlite</code>. <Link to="/benchmarks#the-same-api-on-sqlite">Method, writes and what Forge adds</Link></>}
          />
        </div>
      </div>

      <div className="perf flip">
        <div data-reveal>
          <span className="label">Crucible · Rust page rendering</span>
          <h3>Pages printed by Rust, not rendered by React</h3>
          <p>The build turns pages that only show data into templates. The loader's JSON goes to Rust and the HTML comes back from an I/O thread. A page with no island ships a 1.3 kB script.</p>
          <div className="pipe rust" aria-hidden="true">
            <div><small>Request</small><b>Router</b><span>match, auth, time zone</span></div>
            <div><small>JavaScript</small><b>Loader</b><span>your queries</span></div>
            <div><small>Rust</small><b>Template</b><span>printed on I/O threads</span></div>
            <div><small>Response</small><b>HTML</b><span>no React sent</span></div>
          </div>
          <ul className="points">
            <li><b>{x(products(/as scaffolded/), products(/^Next/))} the requests per second of Next.js, {x(products(/as scaffolded/), products(/^React Router/))} of React Router</b> on a 100-row page.</li>
            <li><b>brust is faster than we are</b> on plain pages ({x(home(/^brust/), home(/rendered each time/))} on the home page, where it runs no JavaScript at all). Forge pages can also be live and signed-in.</li>
          </ul>
          <Link className="btn link" to="/rust-renderer">How pages are printed <Arrow /></Link>
        </div>
        <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
          <Bars
            title="Home page, no data"
            log
            rows={[
              { label: "Forge · kept page", value: home(/as scaffolded/), us: true },
              { label: "brust · alpha.38", value: home(/^brust/) },
              { label: "Forge · printed", value: home(/rendered each time/), us: true },
              { label: "Forge · hydrated", value: home(/whole-page/), us: true },
              { label: "Next.js 16", value: home(/^Next/) },
              { label: "React Router 7", value: home(/^React Router/) },
            ]}
          />
          <Bars
            title="Products, 100 rows from a loader"
            log
            rows={[
              { label: "brust · alpha.38", value: products(/^brust/) },
              { label: "Forge · islands", value: products(/as scaffolded/), us: true },
              { label: "Forge · hydrated", value: products(/whole-page/), us: true },
              { label: "React Router 7", value: products(/^React Router/) },
              { label: "Next.js 16", value: products(/^Next/) },
            ]}
            note={<>4 CPU cores, 2 GiB. <Link to="/rust-renderer">Both formatting variants</Link></>}
          />
        </div>
      </div>

      <div className="perf">
        <div data-reveal>
          <span className="label">Anvil · the built-in thread pool</span>
          <h3>Heavy work off the serving thread</h3>
          <p>One call makes a pool from plain functions, anywhere: a function, a NestJS service, a route. No task module, no <code>isMain</code> guard. The server keeps answering while workers hash, resize and parse.</p>
          <div className="big">
            <div><b>{x(pool.poolWork.rps, pool.inlineWork.rps)}</b><span>throughput with 3 workers on 4 cores</span></div>
            <div><b>{ms(pool.pingInline.p50ms)} → {ms(pool.pingPool.p50ms)}</b><span>a request that does nothing, while the work runs</span></div>
          </div>
          <Code {...poolSnippet} />
          <Link className="btn link" to="/thread-pool" style={{ marginTop: 14 }}>Using Anvil <Arrow /></Link>
        </div>
        <div style={{ display: "grid", gap: 16, minWidth: 0 }} data-reveal>
          <Anvil />
          <Bars
            title="/ping while the server does blocking work"
            log
            rows={[
              { label: "Idle server", value: pool.pingIdle.rps },
              { label: "Work in Anvil", value: pool.pingPool.rps, us: true },
              { label: "Work on one thread", value: pool.pingInline.rps },
            ]}
            note={<>The picture is a model. These bars are measured. <Link to="/thread-pool">Method</Link></>}
          />
        </div>
      </div>
      <Env />
    </>
  );
}
