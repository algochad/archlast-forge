// bun report.ts: turns results.raw (written by run.sh) into results.md.
import { readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";

const rows = readFileSync(new URL("results.raw", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .map((l) => {
    const [label, path, rps, p50, p99, rss, assets] = l.split("|");
    return { label: label!, path: path!, rps: Number(rps), p50: Number(p50), p99: Number(p99), rss: Number(rss), ...JSON.parse(assets!) } as Record<string, any>;
  });

const fmt = (n: number) => (n >= 100 ? Math.round(n).toLocaleString("en-US") : n.toFixed(1));
const table = (path: string, suffix: string, title: string) => {
  const mine = rows.filter((r) => r.path === path && r.label.endsWith(suffix));
  const best = Math.max(...mine.map((r) => r.rps));
  const lines = [`### ${title}`, "", "| | requests/s | p50 ms | p99 ms | peak memory MB | HTML KB | JS to download (gzip KB) |", "|---|---:|---:|---:|---:|---:|---:|"];
  for (const r of mine) lines.push(`| ${r.label.replace(suffix, "")} | ${r.rps === best ? "**" + fmt(r.rps) + "**" : fmt(r.rps)} | ${fmt(r.p50)} | ${fmt(r.p99)} | ${r.rss} | ${(r.htmlBytes / 1024).toFixed(1)} | ${r.jsGzKB} |`);
  return lines.join("\n");
};

const md = [
  `# Results`,
  "",
  `Machine: ${cpus()[0]?.model.trim()}, ${cpus().length} threads; each server pinned to 4 cores and limited to 2 GiB of memory, load from 8 other threads. oha, 64 connections, 5 s per run, median of 3. ${new Date().toISOString().slice(0, 10)}.`,
  "",
  table("/", " [formatters per call]", "Home page (no data)"),
  "",
  table("/products", " [formatters per call]", "Products: 100 rows from the loader, price and date formatted in every row, formatters built per call (how this code is usually written)"),
  "",
  table("/products", " [formatters shared]", "Products: the same page with the formatters built once"),
  "",
].join("\n");
writeFileSync(new URL("results.md", import.meta.url), md);
console.log(md);

// the same numbers for the docs site
const json: Record<string, Record<string, Record<string, unknown>>> = {};
for (const r of rows) {
  const variant = r.label.endsWith(" [formatters shared]") ? "shared" : "perCall";
  const label = r.label.replace(" [formatters shared]", "").replace(" [formatters per call]", "");
  ((json[variant] ??= {})[r.path] ??= {})[label] = { rps: r.rps, p50ms: r.p50, p99ms: r.p99, peakMiB: r.rss, htmlKB: +(r.htmlBytes / 1024).toFixed(1), jsGzKB: r.jsGzKB };
}
writeFileSync(new URL("results.json", import.meta.url), `${JSON.stringify(json, null, 2)}\n`);
