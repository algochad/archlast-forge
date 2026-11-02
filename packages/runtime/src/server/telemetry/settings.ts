// What the observability pages let people configure: SLOs, alert rules (evaluated every minute, delivered to a webhook), and the keys
// other services send OTLP with. They live in the telemetry store, next to the data they are about.
import type { Db } from "../db/types";
import { countUnder, merge, quantile, type Histogram } from "./histogram";
import { TABLES as T } from "./store";

const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

type Window = { count: number; errors: number; clientErrors: number; sum: number; hist: Histogram };

/** Requests in [from, to) for one operation (or all of them), from rollups. */
async function window(db: Db, from: number, to: number, service: string | null, operation: string | null): Promise<Window> {
  const conds = [`"minute" >= ?`, `"minute" < ?`];
  const params: unknown[] = [Math.floor(from / 60_000) - 59, Math.ceil(to / 60_000)];
  if (operation) conds.push(`"operation" = ?`, `"kind" <> '*'`), params.push(operation);
  else conds.push(`"kind" = '*'`);
  if (service) conds.push(`"service" = ?`), params.push(service);
  const rows = await db.query<Record<string, any>>(`SELECT "minute", "res", "count", "errors", "client_errors", "sum", "hist" FROM ${T.rollups} WHERE ${conds.join(" AND ")}`, params);
  const w: Window = { count: 0, errors: 0, clientErrors: 0, sum: 0, hist: {} };
  const fromMinute = Math.floor(from / 60_000);
  for (const r of rows) {
    if (Number(r.minute) + Number(r.res) <= fromMinute) continue;
    w.count += Number(r.count);
    w.errors += Number(r.errors);
    w.clientErrors += Number(r.client_errors);
    w.sum += Number(r.sum);
    merge(w.hist, r.hist);
  }
  return w;
}

// ---- SLOs ----

export interface SloInput {
  name: string;
  service?: string | null;
  operation?: string | null;
  objective: "latency" | "availability";
  /** 0..1, e.g. 0.99. */
  target: number;
  thresholdMs?: number | null;
  windowDays: number;
}

function checkSlo(s: SloInput) {
  if (!s.name?.trim()) throw new Error("An SLO needs a name");
  if (!["latency", "availability"].includes(s.objective)) throw new Error("objective is latency or availability");
  if (!(s.target > 0 && s.target < 1)) throw new Error("target is a fraction between 0 and 1, e.g. 0.99");
  if (s.objective === "latency" && !(Number(s.thresholdMs) > 0)) throw new Error("A latency SLO needs a threshold in milliseconds");
  if (![7, 14, 28, 30, 90].includes(Number(s.windowDays))) throw new Error("window is 7, 14, 28, 30 or 90 days");
}

/** The share of requests that met the objective, or null with no traffic. */
const sli = (w: Window, objective: string, thresholdMs: number | null) =>
  !w.count ? null : objective === "latency" ? Math.min(1, countUnder(w.hist, Number(thresholdMs)) / w.count) : 1 - w.errors / w.count;

export async function sloStatus(db: Db, slo: Record<string, any>, now = Date.now()) {
  const days = Number(slo.window_days);
  const [whole, hour, sixHours] = await Promise.all([
    window(db, now - days * 86_400_000, now, slo.service, slo.operation),
    window(db, now - 3600_000, now, slo.service, slo.operation),
    window(db, now - 6 * 3600_000, now, slo.service, slo.operation),
  ]);
  const target = Number(slo.target);
  const allowed = 1 - target;
  const value = sli(whole, slo.objective, slo.threshold_ms);
  const burn = (w: Window) => {
    const v = sli(w, slo.objective, slo.threshold_ms);
    return v === null ? null : (1 - v) / allowed;
  };
  const remaining = value === null ? null : 1 - (1 - value) / allowed;
  const burn1h = burn(hour);
  const status = value === null ? "no data" : remaining! <= 0 ? "breached" : remaining! < 0.25 || (burn1h ?? 0) >= 2 ? "at risk" : "healthy";
  return {
    id: slo.id,
    name: slo.name,
    service: slo.service,
    operation: slo.operation,
    objective: slo.objective,
    target,
    thresholdMs: slo.threshold_ms === null ? null : Number(slo.threshold_ms),
    windowDays: days,
    createdAt: Number(slo.created_at),
    createdBy: slo.created_by,
    sli: value,
    requests: whole.count,
    budgetRemaining: remaining,
    burn1h,
    burn6h: burn(sixHours),
    p95: quantile(whole.hist, 0.95),
    status,
  };
}

export function buildSettings(db: Db, opts: { deliver?: (url: string, body: object) => Promise<string> } = {}) {
  const deliver =
    opts.deliver ??
    (async (url: string, body: object) => {
      try {
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
        return res.ok ? "delivered" : `failed: HTTP ${res.status}`;
      } catch (e) {
        return `failed: ${(e as Error).message}`;
      }
    });

  const checkWebhook = (url: unknown) => {
    if (url === null || url === undefined || url === "") return null;
    const u = new URL(String(url));
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("The webhook must be an http(s) URL");
    return u.href;
  };

  const settings = {
    // -- SLOs --
    async slos() {
      const rows = await db.query<Record<string, any>>(`SELECT * FROM ${T.slos} ORDER BY "name"`);
      return Promise.all(rows.map((s) => sloStatus(db, s)));
    },
    async saveSlo(input: SloInput & { id?: string }, actor: string) {
      checkSlo(input);
      const values = [input.name.trim(), input.service || null, input.operation || null, input.objective, Number(input.target), input.objective === "latency" ? Number(input.thresholdMs) : null, Number(input.windowDays)];
      if (input.id) {
        await db.execute(`UPDATE ${T.slos} SET "name" = ?, "service" = ?, "operation" = ?, "objective" = ?, "target" = ?, "threshold_ms" = ?, "window_days" = ? WHERE "id" = ?`, [...values, input.id]);
        return input.id;
      }
      const slo = id("slo");
      await db.execute(`INSERT INTO ${T.slos} ("id", "name", "service", "operation", "objective", "target", "threshold_ms", "window_days", "created_at", "created_by") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        slo,
        ...values,
        Date.now(),
        actor,
      ]);
      return slo;
    },
    async deleteSlo({ id: slo }: { id: string }) {
      // With it go the burn-rate rules that watch it: they would have nothing left to measure.
      await db.transaction("write", async (tx) => {
        await tx.execute(`DELETE FROM ${T.slos} WHERE "id" = ?`, [slo]);
        await tx.execute(`DELETE FROM ${T.rules} WHERE "metric" = 'slo_burn' AND "operation" = ?`, [slo]);
      });
      return true;
    },

    // -- alert rules --
    async alertRules() {
      return db.query(`SELECT * FROM ${T.rules} ORDER BY "name"`);
    },
    async saveAlertRule(input: Record<string, any>, actor: string) {
      if (!String(input.name ?? "").trim()) throw new Error("A rule needs a name");
      if (!["error_rate", "failure_rate", "p95", "avg", "requests", "slo_burn", "nodes"].includes(input.metric)) throw new Error("Unknown metric");
      if (![">", "<"].includes(input.comparator)) throw new Error("comparator is > or <");
      if (!Number.isFinite(Number(input.threshold))) throw new Error("threshold must be a number");
      if (![1, 5, 10, 15, 30, 60].includes(Number(input.windowMin))) throw new Error("window is 1, 5, 10, 15, 30 or 60 minutes");
      if (input.metric === "slo_burn" && !input.operation) throw new Error("A burn-rate rule names the SLO it watches");
      const webhook = checkWebhook(input.webhook);
      const values = [String(input.name).trim(), input.metric, input.service || null, input.operation || null, input.comparator, Number(input.threshold), Number(input.windowMin), webhook, input.enabled === false ? 0 : 1];
      if (input.id) {
        await db.execute(
          `UPDATE ${T.rules} SET "name" = ?, "metric" = ?, "service" = ?, "operation" = ?, "comparator" = ?, "threshold" = ?, "window_min" = ?, "webhook" = ?, "enabled" = ?, "state" = 'ok', "since" = NULL WHERE "id" = ?`,
          [...values, input.id],
        );
        return input.id;
      }
      const rule = id("rule");
      await db.execute(
        `INSERT INTO ${T.rules} ("id", "name", "metric", "service", "operation", "comparator", "threshold", "window_min", "webhook", "enabled", "state", "created_at", "created_by") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?)`,
        [rule, ...values, Date.now(), actor],
      );
      return rule;
    },
    async deleteAlertRule({ id: rule }: { id: string }) {
      await db.execute(`DELETE FROM ${T.rules} WHERE "id" = ?`, [rule]);
      return true;
    },
    async alertEvents({ limit }: { limit?: number }) {
      return db.query(`SELECT * FROM ${T.events} ORDER BY "time" DESC LIMIT ?`, [Math.min(Number(limit) || 100, 500)]);
    },
    async notifications() {
      const [unseen] = await db.query<{ n: number }>(`SELECT COUNT(*) AS "n" FROM ${T.events} WHERE "seen" = 0`);
      const firing = await db.query(`SELECT "id", "name", "since", "value", "threshold", "comparator", "metric" FROM ${T.rules} WHERE "state" = 'firing' AND "enabled" = 1`);
      return { unseen: Number(unseen?.n ?? 0), firing, recent: await db.query(`SELECT * FROM ${T.events} ORDER BY "time" DESC LIMIT 12`) };
    },
    async markSeen() {
      await db.execute(`UPDATE ${T.events} SET "seen" = 1 WHERE "seen" = 0`);
      return true;
    },
    /** Sends a sample notification to a rule's webhook, to check it is wired up. */
    async testAlert({ webhook }: { webhook: string }) {
      const url = checkWebhook(webhook);
      if (!url) throw new Error("No webhook to test");
      return deliver(url, { text: "archlast forge: test notification from the dashboard", test: true, time: new Date().toISOString() });
    },

    /** What a rule measures now, over its window. */
    async measure(rule: Record<string, any>, now = Date.now()): Promise<number | null> {
      if (rule.metric === "slo_burn") {
        const [slo] = await db.query<Record<string, any>>(`SELECT * FROM ${T.slos} WHERE "id" = ?`, [rule.operation]);
        if (!slo) return null;
        const w = await window(db, now - Number(rule.window_min) * 60_000, now, slo.service, slo.operation);
        const v = sli(w, slo.objective, slo.threshold_ms);
        return v === null ? null : (1 - v) / (1 - Number(slo.target));
      }
      // Nodes that reported in the window (every server process samples every 10 s): fewer than 1 is a service gone silent, fewer than 2 a
      // service a scaler (or a crash) left without its spare.
      if (rule.metric === "nodes") {
        const [row] = await db.query<{ n: number }>(`SELECT COUNT(*) AS "n" FROM (SELECT DISTINCT "service", "instance" FROM ${T.samples} WHERE "role" = 'server' AND "time" >= ? AND "time" <= ?${rule.service ? ` AND "service" = ?` : ""}) live`, [
          now - Number(rule.window_min) * 60_000,
          now,
          ...(rule.service ? [rule.service] : []),
        ]);
        return Number(row?.n ?? 0);
      }
      const w = await window(db, now - Number(rule.window_min) * 60_000, now, rule.service, rule.operation);
      if (rule.metric === "requests") return w.count;
      if (!w.count) return null;
      if (rule.metric === "error_rate") return (w.errors / w.count) * 100;
      if (rule.metric === "failure_rate") return ((w.errors + w.clientErrors) / w.count) * 100;
      if (rule.metric === "avg") return w.sum / w.count;
      return quantile(w.hist, 0.95);
    },

    /** Runs every minute: rules whose condition changed fire or resolve, with an event and a webhook call. */
    async evaluate(now = Date.now()) {
      const rules = await db.query<Record<string, any>>(`SELECT * FROM ${T.rules} WHERE "enabled" = 1`);
      for (const rule of rules) {
        const value = await settings.measure(rule, now);
        const breached = value !== null && (rule.comparator === ">" ? value > Number(rule.threshold) : value < Number(rule.threshold));
        await db.execute(`UPDATE ${T.rules} SET "value" = ?, "evaluated_at" = ? WHERE "id" = ?`, [value, now, rule.id]);
        // A window with no requests has no rate or latency: it says neither that the problem started nor that it is over.
        if (value === null) continue;
        const firing = rule.state === "firing";
        if (breached === firing) continue;
        const state = breached ? "firing" : "resolved";
        const shown = value === null ? "no data" : rule.metric.endsWith("rate") ? `${value.toFixed(2)}%` : rule.metric === "requests" ? String(Math.round(value)) : rule.metric === "nodes" ? `${value} live` : rule.metric === "slo_burn" ? `${value.toFixed(2)}×` : `${Math.round(value)} ms`;
        const message = breached
          ? `${rule.name}: ${rule.metric.replace("_", " ")} is ${shown} (${rule.comparator} ${rule.threshold}) over the last ${rule.window_min} min`
          : `${rule.name} resolved: ${rule.metric.replace("_", " ")} is ${shown}`;
        const delivery = rule.webhook ? await deliver(rule.webhook, { text: message, rule: { id: rule.id, name: rule.name, metric: rule.metric, threshold: Number(rule.threshold), comparator: rule.comparator, service: rule.service, operation: rule.operation }, state, value, time: new Date(now).toISOString() }) : null;
        await db.transaction("write", async (tx) => {
          await tx.execute(`UPDATE ${T.rules} SET "state" = ?, "since" = ? WHERE "id" = ?`, [breached ? "firing" : "ok", now, rule.id]);
          await tx.execute(`INSERT INTO ${T.events} ("id", "rule_id", "rule_name", "time", "state", "value", "message", "delivery", "seen") VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`, [
            id("evt"),
            rule.id,
            rule.name,
            now,
            state,
            value,
            message,
            delivery,
          ]);
        });
      }
    },

    // -- ingest keys --
    async keys() {
      return db.query(`SELECT "id", "name", "prefix", "service", "created_at", "created_by", "last_used" FROM ${T.keys} ORDER BY "created_at" DESC`);
    },
    async createKey({ name, service }: { name: string; service?: string }, actor: string) {
      if (!String(name ?? "").trim()) throw new Error("A key needs a name");
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      const key = `afk_${Buffer.from(bytes).toString("base64url")}`;
      await db.execute(`INSERT INTO ${T.keys} ("id", "name", "hash", "prefix", "service", "created_at", "created_by") VALUES (?, ?, ?, ?, ?, ?, ?)`, [
        id("key"),
        String(name).trim(),
        sha256(key),
        key.slice(0, 10),
        service || null,
        Date.now(),
        actor,
      ]);
      return { key };
    },
    async revokeKey({ id: key }: { id: string }) {
      await db.execute(`DELETE FROM ${T.keys} WHERE "id" = ?`, [key]);
      return true;
    },
    /** The key's record when `key` is a live ingest key; records its use at most once a minute. */
    async verifyKey({ key }: { key: string }) {
      const [row] = await db.query<Record<string, any>>(`SELECT "id", "service", "last_used" FROM ${T.keys} WHERE "hash" = ?`, [sha256(String(key))]);
      if (!row) return null;
      if (!row.last_used || Date.now() - Number(row.last_used) > 60_000) await db.execute(`UPDATE ${T.keys} SET "last_used" = ? WHERE "id" = ?`, [Date.now(), row.id]);
      return { id: row.id, service: row.service ?? null };
    },
  };
  return settings;
}

export type Settings = ReturnType<typeof buildSettings>;
