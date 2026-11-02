// Ported from Traceway (https://github.com/tracewayapp/traceway), MIT License, Copyright (c) 2026 dusanstanojeviccs (the full notice is in
// THIRD_PARTY_NOTICES.md at the root of this package):
// the exception fingerprint (backend/app/controllers/clientcontrollers/client.controller.go, ComputeExceptionHash) and the endpoint
// impact score (backend/app/repositories/telemetry/shared/impact.go). The thresholds and their order are Traceway's; what differs is
// marked where it happens.

const errorMessageRe = /^(\*?[\w.]+):\s*.+/gm;
const causedByRe = /^(Caused by:\s*[\w.$]+):\s*.+/gm;
const jsFuncLineRe = /^( {0,4})(.+)\(\)(\n {4}.+:\d+:\d+)$/gm;
const urlOriginRe = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s]*/g;
const absolutePathRe = /\/[^\s:]+\/([^/\s:]+:\d+)/g;
const laterLineColRe = /^(\s*.+:(?:[2-9]|[1-9]\d+)):\d+$/gm;
const versionRe = /@v[\d.]+/g;
const hexRe = /0x[0-9a-fA-F]+/g;
const uuidRe = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const largeNumberRe = /(^|[^:\d])(\d{5,})($|[^\d])/g;
const emailRe = /[\w.-]+@[\w.-]+\.\w+/g;
const ipRe = /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?/g;
const goroutineRe = /goroutine \d+/g;
const javaLineNumRe = /\((\w[\w.$]*\.(?:java|kt|scala)):\d+\)/g;
const javaEllipsisRe = /\.\.\. \d+ more/g;
const spacesRe = /[ \t]+/g;
const newlinesRe = /\n+/g;

/** Values that differ between occurrences of one bug: ids, addresses, emails. */
const normalizeValues = (s: string) =>
  s
    .replace(hexRe, "<hex>")
    .replace(uuidRe, "<uuid>")
    .replace(largeNumberRe, "$1<id>$3")
    .replace(emailRe, "<email>")
    .replace(ipRe, "<ip>");

/**
 * Frames in the app's own code: a stack's frames from dependencies and the runtime move with every upgrade, and say nothing about
 * which bug it is. Not in Traceway, which hashes every frame; with no app frame left, all of them are kept.
 */
function appFrames(stack: string) {
  const lines = stack.split("\n");
  const head = lines.filter((l) => !/^\s+at /.test(l));
  const frames = lines.filter((l) => /^\s+at /.test(l));
  const own = frames.filter((l) => !/node_modules|\(native\)|\bnode:|\bbun:|\[native code\]/.test(l));
  return [...head, ...(own.length ? own : frames)].join("\n");
}

/**
 * Groups occurrences of one error: the error's type and the shape of its stack, with messages, paths, columns and variable values taken
 * out. A message with no stack (a ForgeError, a log line) is grouped by its text, with variable values taken out (Traceway keeps such
 * messages exactly as they are).
 */
export function fingerprint(type: string, message: string, stack?: string): string {
  let normalized: string;
  if (stack && /^\s+at /m.test(stack)) {
    normalized = appFrames(stack)
      .replace(causedByRe, "$1")
      .replace(errorMessageRe, "$1")
      .replace(jsFuncLineRe, "$1<fn>$3")
      .replace(urlOriginRe, "")
      .replace(absolutePathRe, "$1")
      .replace(laterLineColRe, "$1")
      .replace(versionRe, "");
    normalized = normalizeValues(normalized)
      .replace(goroutineRe, "goroutine <n>")
      .replace(javaLineNumRe, "($1)")
      .replace(javaEllipsisRe, "... more")
      .replace(spacesRe, " ")
      .replace(newlinesRe, "\n");
  } else normalized = `${type}: ${normalizeValues(message)}`;
  const hash = new Bun.CryptoHasher("sha256").update(normalized.trim()).digest("hex");
  return hash.slice(0, 16);
}

// ---- impact ----

export interface ImpactInput {
  operation: string;
  total: number;
  /** Fast enough and not a server error. */
  satisfied: number;
  tolerating: number;
  /** Too slow, or a server error. */
  bad: number;
  clientErrors: number;
  p99Ms: number;
  /** A per-operation allowance subtracted from the p99 before it is judged (Traceway's slow-threshold override). */
  offsetMs?: number;
}

function factors(i: ImpactInput) {
  const badRate = i.total ? i.bad / i.total : 0;
  const clientRate = i.total ? i.clientErrors / i.total : 0;
  const apdex = i.total ? 1 - (i.satisfied + i.tolerating * 0.5) / i.total : 0;
  const errorRate = badRate > 0.33 ? 0.75 : badRate > 0.2 ? 0.5 : badRate > 0.1 ? 0.25 : 0;
  const p99 = i.p99Ms - (i.offsetMs ?? 0);
  const p99Score = p99 > 8000 ? 0.75 : p99 > 6000 ? 0.5 : p99 > 3000 ? 0.25 : 0;
  const client = i.operation === "UNMATCHED" || i.total <= 10 ? 0 : clientRate > 0.5 ? 0.75 : clientRate > 0.25 ? 0.5 : 0;
  const b = i.bad;
  const volume =
    badRate > 0.1 && b >= 500
      ? 0.75
      : badRate > 0.1 && b >= 50
        ? 0.5
        : badRate > 0.05 && b >= 2000
          ? 0.75
          : badRate > 0.05 && b >= 500
            ? 0.5
            : badRate > 0.05 && b >= 50
              ? 0.25
              : badRate > 0.01 && b >= 10000
                ? 0.75
                : badRate > 0.01 && b >= 2000
                  ? 0.5
                  : badRate > 0.01 && b >= 500
                    ? 0.25
                    : 0;
  return { apdex, errorRate, p99: p99Score, client, volume, badRate, clientRate };
}

/** 0 (healthy) to 1: the worst of the inverted Apdex and four floors (error rate, p99, client errors, error volume). */
export function impactScore(i: ImpactInput): number {
  if (!i.total) return 0;
  const f = factors(i);
  return Math.max(f.apdex, f.errorRate, f.p99, f.client, f.volume);
}

const human = (ms: number) => (ms >= 1000 ? (ms >= 10_000 ? `${(ms / 1000).toFixed(0)}s` : `${(ms / 1000).toFixed(1)}s`) : `${ms.toFixed(0)}ms`);

/** Why the score is what it is, in a sentence; ties go to p99, then volume, client errors, error rate and Apdex. */
export function impactReason(i: ImpactInput): string {
  if (!i.total) return "Healthy";
  const f = factors(i);
  const max = Math.max(f.apdex, f.errorRate, f.p99, f.client, f.volume);
  if (max < 0.25) return "Healthy";
  if (f.p99 >= max) return `P99 latency is ${human(i.p99Ms)}`;
  if (f.volume >= max) return `${Math.round(i.bad).toLocaleString("en-US")} errors with ${(f.badRate * 100).toFixed(1)}% error rate`;
  if (f.client >= max) return `${(f.clientRate * 100).toFixed(0)}% of requests returning 4xx errors`;
  if (f.errorRate >= max) return `${(f.badRate * 100).toFixed(0)}% of requests are slow or failing`;
  return `${((1 - i.satisfied / i.total) * 100).toFixed(0)}% of requests are slow or failing`;
}

/**
 * The Apdex threshold T for a kind of request: satisfied at or under T, tolerating up to 2T (Traceway's split, 750 ms and 1.5 s for
 * HTTP endpoints). Function calls are held to tighter thresholds than Traceway's HTTP default, jobs to looser ones.
 */
export const APDEX_T: Record<string, number> = {
  query: 250,
  live: 250,
  mutation: 400,
  action: 1000,
  http: 750,
  auth: 750,
  page: 750,
  server: 750,
  rpc: 500,
  ws: 500,
  job: 2000,
  cron: 2000,
  consumer: 2000,
};
export const apdexT = (kind: string) => APDEX_T[kind] ?? 750;
