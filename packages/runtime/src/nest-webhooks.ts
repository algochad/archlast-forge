// Webhooks for Nest inside archlast-forge, sent and received, after @nestjs/webhooks: the same signatures (Standard Webhooks), retry schedule,
// endpoint rules and SSRF guard, kept in the engine's own document database instead of a SQL store of their own.
//
// - Sending is an outbox: `webhooks.dispatch()` in a mutation writes the message and one delivery per subscribed endpoint in that mutation's
//   transaction, so a message exists only if the change it describes committed, and the scheduler delivers it afterwards. Each attempt is
//   claimed, sent, and settled in its own mutation: retried with backoff, logged, paced on 429/502/503/504, and the endpoint disabled on 410
//   or after failing for days.
// - Receiving is a guard and an inbox: `@VerifyWebhook("payments")` checks the signature on the raw body and the timestamp before the
//   handler runs, and `webhookInbox.once()` in the mutation that applies the webhook records its id in the same transaction, so a
//   redelivered webhook changes nothing and a failed one is applied when the sender retries.
//
// Wiring (forge/): spread `webhookTables` into schema.ts, export `webhookFunctions()` from forge/webhooks.ts, import
// `WebhooksModule.forRoot({...})` in a feature module. See apps/docs/content/webhooks.mdx.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
// By the package's own name, not "./nest": the build keeps nest.ts its own entry then (see nest-websockets.ts).
import {
  applyDecorators,
  createParamDecorator,
  ForgeService,
  Inject,
  Injectable,
  inject,
  Module,
  SetMetadata,
  UnauthorizedException,
  UseGuards,
  type CanActivate,
  type DynamicModule,
  type ExecutionContext,
} from "@archlast/forge-runtime/nest";
import { ForgeError } from "./errors";
import { internalAction, internalMutation, type ActionCtx, type MutationCtx, type QueryCtx } from "./functions";
import { defineTable } from "./schema";
import { v } from "./values";
import { destinationOf, sendTo } from "./webhook-destination";

// ---------------------------------------------------------------------------------------------------------------------------------
// Options

export interface WebhookRetryOptions {
  /** Attempts in all, counting the first. Default 10. */
  attempts?: number;
  /** The first retry's delay. Default 5 s. */
  delayMs?: number;
  /** Each retry waits this many times longer than the one before. Default 4. */
  factor?: number;
  /** No wait is longer, `Retry-After` included. Default 1 day. */
  maxDelayMs?: number;
}

/** How a receiver checks what a sender signed. `"standard"` is Standard Webhooks (webhook-id, webhook-timestamp, webhook-signature). */
export interface WebhookScheme {
  /**
   * Checks the request and returns the webhook's id (what the inbox deduplicates on) and, when the scheme signs one, its timestamp in ms.
   * Returns null when the signature does not match one of `secrets`. Compare in constant time.
   */
  verify(request: { headers: Record<string, string | undefined>; rawBody: Buffer }, secrets: string[]): { id: string; timestamp?: number } | null;
}

export interface WebhookReceiver {
  /** The secret (or secrets, during a rotation: each is tried) the sender signs with: `whsec_…` (base64) or plain text. A function is read on each request. */
  secret: string | string[] | (() => string | string[] | undefined);
  /** Default `"standard"`. */
  scheme?: "standard" | WebhookScheme;
  /** The largest difference between the signed timestamp and now, either way. Default 5 minutes. */
  toleranceMs?: number;
}

export interface WebhooksOptions {
  /** The event types that may be dispatched and subscribed to. Unset: any. Endpoints may also subscribe to `"*"`. */
  eventTypes?: string[];
  retry?: WebhookRetryOptions;
  /** Per attempt: connect, send and read the response. Default 15 s. */
  timeoutMs?: number;
  /** An endpoint that has failed every attempt for this long is disabled. Default 5 days; `false` never. */
  disableEndpointAfterMs?: number | false;
  /** How long a rotated-out secret keeps signing beside the new one. Default 24 hours. */
  secretRotationOverlapMs?: number;
  /** Allow `http://` endpoints. Default false: HTTPS only. */
  allowHttp?: boolean;
  /** Allow loopback and private addresses (tests, a private network you own). Link-local and cloud metadata addresses stay blocked. */
  allowPrivateNetworks?: boolean;
  /** Addresses or CIDR ranges allowed even though they are private, as `"10.1.2.0/24"`. */
  allowedAddresses?: string[];
  /** How much of an endpoint's response is kept in the attempt log. Default 4096 bytes. */
  maxResponseBytes?: number;
  /** The function module that exports `webhookFunctions()`. Default `"webhooks"` (forge/webhooks.ts). */
  functions?: string;
  /** Inbound senders by name, for `@VerifyWebhook(name)`. */
  receivers?: Record<string, WebhookReceiver>;
}

interface Resolved extends Required<Omit<WebhooksOptions, "eventTypes" | "receivers" | "retry">> {
  eventTypes?: string[];
  receivers: Record<string, WebhookReceiver>;
  retry: Required<WebhookRetryOptions>;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const resolve = (o: WebhooksOptions): Resolved => ({
  eventTypes: o.eventTypes,
  retry: { attempts: 10, delayMs: 5_000, factor: 4, maxDelayMs: DAY, ...o.retry },
  timeoutMs: o.timeoutMs ?? 15_000,
  disableEndpointAfterMs: o.disableEndpointAfterMs ?? 5 * DAY,
  secretRotationOverlapMs: o.secretRotationOverlapMs ?? DAY,
  allowHttp: o.allowHttp ?? false,
  allowPrivateNetworks: o.allowPrivateNetworks ?? false,
  allowedAddresses: o.allowedAddresses ?? [],
  maxResponseBytes: o.maxResponseBytes ?? 4096,
  functions: o.functions ?? "webhooks",
  receivers: o.receivers ?? {},
});

/** The injection token for the module's options. */
export const WEBHOOKS_OPTIONS = Symbol.for("archlast-forge.webhooks.options");

// ---------------------------------------------------------------------------------------------------------------------------------
// Tables: documents in the app's own database.

/**
 * The tables webhooks keep, to spread into `defineSchema({ ...webhookTables, … })`. Endpoints (with their secrets), messages, one delivery
 * per message and endpoint, the attempt log, and the inbox of received webhook ids.
 */
export const webhookTables = {
  webhookEndpoints: defineTable({
    url: v.string(),
    /** Newest first. A rotated-out secret has `expiresAt` and keeps signing until then. */
    secrets: v.array(v.object({ secret: v.string(), expiresAt: v.optional(v.number()) })),
    eventTypes: v.array(v.string()),
    tenant: v.optional(v.string()),
    description: v.optional(v.string()),
    metadata: v.optional(v.any()),
    disabled: v.optional(v.boolean()),
    /** `failing` (after `disableEndpointAfterMs`), `gone` (the endpoint answered 410) or `manual`. */
    disabledReason: v.optional(v.string()),
    failingSince: v.optional(v.number()),
    /** Deliveries wait until then (after a 429, 502, 503 or 504). */
    pausedUntil: v.optional(v.number()),
  }).index("by_tenant", ["tenant"]),
  webhookMessages: defineTable({
    msgId: v.string(),
    type: v.string(),
    tenant: v.optional(v.string()),
    data: v.any(),
    timestamp: v.number(),
  }).index("by_msgId", ["msgId"]),
  webhookDeliveries: defineTable({
    messageId: v.id("webhookMessages"),
    endpointId: v.id("webhookEndpoints"),
    type: v.string(),
    tenant: v.optional(v.string()),
    /** `pending`, `sending`, `delivered` or `failed`. */
    status: v.string(),
    /** Why a delivery failed: `rejected` (410), `exhausted`, `blocked` (SSRF), `disabled` (the endpoint was). */
    reason: v.optional(v.string()),
    attempts: v.number(),
    nextAttemptAt: v.optional(v.number()),
    leaseUntil: v.optional(v.number()),
    job: v.optional(v.string()),
    lastStatusCode: v.optional(v.number()),
    lastError: v.optional(v.string()),
    deliveredAt: v.optional(v.number()),
  })
    .index("by_endpoint", ["endpointId"])
    .index("by_message", ["messageId"])
    .index("by_status", ["status"]),
  webhookAttempts: defineTable({
    deliveryId: v.id("webhookDeliveries"),
    endpointId: v.id("webhookEndpoints"),
    attempt: v.number(),
    at: v.number(),
    durationMs: v.number(),
    statusCode: v.optional(v.number()),
    error: v.optional(v.string()),
    response: v.optional(v.string()),
  }).index("by_delivery", ["deliveryId"]),
  webhookInbox: defineTable({ receiver: v.string(), webhookId: v.string(), receivedAt: v.number() }).index("by_receiver_webhook", [
    "receiver",
    "webhookId",
  ]),
};

// The engine's ctx.db, untyped: these tables are the app's, so the app's data model has their types, not this file.
type Doc = Record<string, any> & { _id: string; _creationTime: number };
interface Db {
  get(id: string): Promise<Doc | null>;
  insert(table: string, doc: object): Promise<string>;
  patch(id: string, fields: object): Promise<void>;
  delete(id: string): Promise<void>;
  query(table: string): any;
}
const dbOf = (ctx: QueryCtx | MutationCtx) => ctx.db as unknown as Db;

// ---------------------------------------------------------------------------------------------------------------------------------
// Signatures (Standard Webhooks: https://www.standardwebhooks.com)

const keyOf = (secret: string) => (secret.startsWith("whsec_") ? Buffer.from(secret.slice(6), "base64") : Buffer.from(secret, "utf8"));

/** A new endpoint secret: `whsec_` and 24 random bytes in base64. */
export const generateWebhookSecret = () => `whsec_${randomBytes(24).toString("base64")}`;

/** The `webhook-signature` value for a message: `v1,<base64 HMAC-SHA256 of "id.timestamp.body">`, one per secret, space-separated. */
export function signWebhook(o: { id: string; timestamp: number; body: string; secrets: string | string[] }) {
  return [o.secrets]
    .flat()
    .map((s) => `v1,${createHmac("sha256", keyOf(s)).update(`${o.id}.${o.timestamp}.${o.body}`).digest("base64")}`)
    .join(" ");
}

const sameBytes = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

/** Standard Webhooks: the id, the signed timestamp (seconds) and at least one `v1` signature that one of `secrets` made. */
export const standardScheme: WebhookScheme = {
  verify({ headers, rawBody }, secrets) {
    const id = headers["webhook-id"];
    const ts = headers["webhook-timestamp"];
    const given = (headers["webhook-signature"] ?? "").split(" ").filter((s) => s.startsWith("v1,")).map((s) => Buffer.from(s.slice(3), "base64"));
    if (!id || !ts || !/^\d+$/.test(ts) || !given.length) return null;
    const signed = Buffer.from(`${id}.${ts}.`);
    for (const secret of secrets) {
      const expected = createHmac("sha256", keyOf(secret)).update(signed).update(rawBody).digest();
      if (given.some((g) => sameBytes(g, expected))) return { id, timestamp: Number(ts) * 1000 };
    }
    return null;
  },
};

/**
 * A sender that signs the body alone with an HMAC in one header (GitHub's `x-hub-signature-256: sha256=<hex>`, and many others). With no
 * signed id, the id is a hash of the body, so a redelivery is caught by what was signed rather than by an unsigned delivery header.
 */
export function hmacScheme(o: { header: string; prefix?: string; algorithm?: "sha256" | "sha1" | "sha512"; encoding?: "hex" | "base64" }): WebhookScheme {
  const algorithm = o.algorithm ?? "sha256";
  const encoding = o.encoding ?? "hex";
  return {
    verify({ headers, rawBody }, secrets) {
      const value = headers[o.header.toLowerCase()];
      if (!value || (o.prefix && !value.startsWith(o.prefix))) return null;
      const given = Buffer.from(value.slice(o.prefix?.length ?? 0), encoding);
      for (const secret of secrets)
        if (sameBytes(given, createHmac(algorithm, secret).update(rawBody).digest())) return { id: createHash("sha256").update(rawBody).digest("hex") };
      return null;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Sending

/** One line of what `dispatch()` takes. `id` makes it idempotent: dispatching the same id again sends nothing new. */
export interface WebhookMessageInput {
  type: string;
  data: unknown;
  tenant?: string;
  id?: string;
}

const refOf = (o: Resolved, fn: "deliver" | "claim" | "settle") => `${o.functions}:${fn}` as never;

/** Sends webhooks from a mutation: `await this.webhooks.dispatch({ type: "order.shipped", tenant, data })`. */
export class Webhooks extends ForgeService<MutationCtx> {
  protected readonly options!: Resolved;

  /** Writes the message and a delivery for every enabled endpoint subscribed to its type (and tenant), in this mutation's transaction. */
  async dispatch(message: WebhookMessageInput): Promise<{ messageId: string; msgId: string; deliveries: number }> {
    const o = this.options;
    if (o.eventTypes && !o.eventTypes.includes(message.type)) throw new ForgeError(`Unknown webhook event type "${message.type}"`);
    const db = dbOf(this.ctx);
    if (message.id) {
      const known = await db.query("webhookMessages").withIndex("by_msgId", (q: any) => q.eq("msgId", message.id)).first();
      if (known) return { messageId: known._id, msgId: known.msgId, deliveries: 0 };
    }
    const msgId = message.id ?? `msg_${randomBytes(12).toString("hex")}`;
    const messageId = await db.insert("webhookMessages", { msgId, type: message.type, tenant: message.tenant, data: message.data ?? null, timestamp: Date.now() });
    const endpoints: Doc[] =
      message.tenant !== undefined
        ? await db.query("webhookEndpoints").withIndex("by_tenant", (q: any) => q.eq("tenant", message.tenant)).collect()
        : (await db.query("webhookEndpoints").collect()).filter((e: Doc) => e.tenant === undefined);
    let deliveries = 0;
    for (const e of endpoints) {
      if (e.disabled || !(e.eventTypes.includes("*") || e.eventTypes.includes(message.type))) continue;
      const deliveryId = await db.insert("webhookDeliveries", { messageId, endpointId: e._id, type: message.type, tenant: message.tenant, status: "pending", attempts: 0 });
      const job = await this.ctx.scheduler.runAfter(0, refOf(o, "deliver"), { deliveryId } as never);
      await db.patch(deliveryId, { job });
      deliveries++;
    }
    return { messageId, msgId, deliveries };
  }
}

/** An endpoint as `WebhookLog` gives it: everything but its secrets. */
export interface WebhookEndpointView {
  _id: string;
  _creationTime: number;
  url: string;
  eventTypes: string[];
  tenant?: string;
  description?: string;
  metadata?: unknown;
  disabled?: boolean;
  /** `failing`, `gone` or `manual`. */
  disabledReason?: string;
  failingSince?: number;
  pausedUntil?: number;
  /** How many secrets sign right now (more than one during a rotation). */
  secretCount: number;
}

/** One message to one endpoint. */
export interface WebhookDelivery {
  _id: string;
  _creationTime: number;
  messageId: string;
  endpointId: string;
  type: string;
  tenant?: string;
  status: "pending" | "sending" | "delivered" | "failed";
  /** Why it failed: `rejected` (410), `exhausted`, `blocked`, `disabled`. */
  reason?: string;
  attempts: number;
  nextAttemptAt?: number;
  lastStatusCode?: number;
  lastError?: string;
  deliveredAt?: number;
}

/** One attempt of a delivery, as the attempt log keeps it. */
export interface WebhookAttempt {
  _id: string;
  _creationTime: number;
  deliveryId: string;
  endpointId: string;
  attempt: number;
  at: number;
  durationMs: number;
  statusCode?: number;
  error?: string;
  response?: string;
}

const publicEndpoint = ({ secrets, ...e }: Doc) => ({ ...e, secretCount: (secrets as unknown[]).length }) as WebhookEndpointView;

/** Endpoint management from mutations: create (returns its secret once), update, rotate the secret, delete, retry a failed delivery. */
export class WebhookEndpoints extends ForgeService<MutationCtx> {
  protected readonly options!: Resolved;

  private async owned(id: string, tenant: string | undefined) {
    const e = await dbOf(this.ctx).get(id);
    if (!e || !id.startsWith("webhookEndpoints:") || e.tenant !== tenant) throw new ForgeError("No such webhook endpoint");
    return e;
  }

  private checkTypes(types: string[]) {
    const known = this.options.eventTypes;
    for (const t of types) if (t !== "*" && known && !known.includes(t)) throw new ForgeError(`Unknown webhook event type "${t}"`);
    if (!types.length) throw new ForgeError("An endpoint subscribes to at least one event type");
  }

  private checkUrl(url: string) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new ForgeError("The endpoint URL is not a URL");
    }
    if (u.protocol !== "https:" && !(this.options.allowHttp && u.protocol === "http:")) throw new ForgeError("The endpoint URL must be https://");
    if (u.username || u.password || u.hash) throw new ForgeError("The endpoint URL may not carry credentials or a fragment");
  }

  async create(input: { url: string; eventTypes: string[]; tenant?: string; description?: string; metadata?: unknown; secret?: string }) {
    this.checkUrl(input.url);
    this.checkTypes(input.eventTypes);
    const secret = input.secret ?? generateWebhookSecret();
    const id = await dbOf(this.ctx).insert("webhookEndpoints", {
      url: input.url,
      secrets: [{ secret }],
      eventTypes: input.eventTypes,
      tenant: input.tenant,
      description: input.description,
      metadata: input.metadata,
    });
    return { id, secret };
  }

  async update(id: string, changes: { url?: string; eventTypes?: string[]; description?: string; disabled?: boolean }, tenant?: string) {
    await this.owned(id, tenant);
    if (changes.url !== undefined) this.checkUrl(changes.url);
    if (changes.eventTypes) this.checkTypes(changes.eventTypes);
    const enable = changes.disabled === false ? { disabledReason: undefined, failingSince: undefined, pausedUntil: undefined } : {};
    const disable = changes.disabled === true ? { disabledReason: "manual" } : {};
    await dbOf(this.ctx).patch(id, { ...changes, ...enable, ...disable });
  }

  /** A new secret signs from now on; the current ones keep signing beside it for `overlapMs` (default the module's 24 h), so receivers can switch. */
  async rotateSecret(id: string, o: { overlapMs?: number; secret?: string; tenant?: string } = {}) {
    const e = await this.owned(id, o.tenant);
    const now = Date.now();
    const until = now + (o.overlapMs ?? this.options.secretRotationOverlapMs);
    const secret = o.secret ?? generateWebhookSecret();
    const kept = (e.secrets as { secret: string; expiresAt?: number }[])
      .filter((s) => !s.expiresAt || s.expiresAt > now)
      .map((s) => ({ secret: s.secret, expiresAt: Math.min(s.expiresAt ?? until, until) }))
      .filter((s) => s.expiresAt > now);
    await dbOf(this.ctx).patch(id, { secrets: [{ secret }, ...kept] });
    return { secret };
  }

  /** Deletes the endpoint. Its deliveries that have not gone out fail as `disabled`. */
  async remove(id: string, tenant?: string) {
    await this.owned(id, tenant);
    await dbOf(this.ctx).delete(id);
  }

  /** Sends a failed delivery again from its first attempt. */
  async retry(deliveryId: string, tenant?: string) {
    const db = dbOf(this.ctx);
    const d = await db.get(deliveryId);
    if (!d || !deliveryId.startsWith("webhookDeliveries:") || d.tenant !== tenant) throw new ForgeError("No such webhook delivery");
    if (d.status !== "failed") throw new ForgeError("Only a failed delivery can be retried");
    const job = await this.ctx.scheduler.runAfter(0, refOf(this.options, "deliver"), { deliveryId } as never);
    await db.patch(deliveryId, { status: "pending", reason: undefined, attempts: 0, nextAttemptAt: undefined, job });
  }
}

/** Reads for the app's own screens and REST: endpoints (without secrets), a page of deliveries, the attempts of one. */
export class WebhookLog extends ForgeService<QueryCtx> {
  async endpoints(tenant?: string): Promise<WebhookEndpointView[]> {
    const db = dbOf(this.ctx);
    const all: Doc[] =
      tenant !== undefined
        ? await db.query("webhookEndpoints").withIndex("by_tenant", (q: any) => q.eq("tenant", tenant)).collect()
        : (await db.query("webhookEndpoints").collect()).filter((e: Doc) => e.tenant === undefined);
    return all.map(publicEndpoint);
  }

  async endpoint(id: string, tenant?: string): Promise<WebhookEndpointView> {
    const e = await dbOf(this.ctx).get(id);
    if (!e || !id.startsWith("webhookEndpoints:") || e.tenant !== tenant) throw new ForgeError("No such webhook endpoint");
    return publicEndpoint(e);
  }

  /** An endpoint's deliveries, newest first, as `.paginate()` gives them (use `usePaginatedQuery` or pass the cursor back over REST). */
  async deliveries(
    endpointId: string,
    paginationOpts: { numItems: number; cursor: string | null },
    tenant?: string,
  ): Promise<{ page: WebhookDelivery[]; isDone: boolean; continueCursor: string; total?: number }> {
    await this.endpoint(endpointId, tenant);
    return dbOf(this.ctx).query("webhookDeliveries").withIndex("by_endpoint", (q: any) => q.eq("endpointId", endpointId)).order("desc").paginate(paginationOpts);
  }

  async attempts(deliveryId: string, tenant?: string): Promise<WebhookAttempt[]> {
    const db = dbOf(this.ctx);
    const d = await db.get(deliveryId);
    if (!d || !deliveryId.startsWith("webhookDeliveries:") || d.tenant !== tenant) throw new ForgeError("No such webhook delivery");
    return db.query("webhookAttempts").withIndex("by_delivery", (q: any) => q.eq("deliveryId", deliveryId)).collect();
  }
}

/** What one attempt needs, from `claim`. */
interface Claimed {
  attempt: number;
  url: string;
  msgId: string;
  body: string;
  secrets: string[];
}

/** The outcome of one attempt, for `settle`. */
interface Outcome {
  deliveryId: string;
  attempt: number;
  durationMs: number;
  statusCode?: number;
  error?: string;
  response?: string;
  retryAfterMs?: number;
  blocked?: boolean;
}

/** The delivery state machine, in mutations: claim an attempt (with a fallback in case it never settles), settle it. */
export class WebhookDeliveries extends ForgeService<MutationCtx> {
  protected readonly options!: Resolved;

  async claim(deliveryId: string): Promise<Claimed | null> {
    const o = this.options;
    const db = dbOf(this.ctx);
    const now = Date.now();
    const d = await db.get(deliveryId);
    if (!d || d.status === "delivered" || d.status === "failed") return null;
    if (d.status === "sending" && (d.leaseUntil ?? 0) > now) return null; // being sent; this was a duplicate wake-up
    const endpoint = await db.get(d.endpointId);
    if (!endpoint || endpoint.disabled) {
      await db.patch(deliveryId, { status: "failed", reason: "disabled", job: undefined, leaseUntil: undefined });
      return null;
    }
    // Paused (a 429/502/503/504): deliveries wait for the pause. One whose own retry was already timed for after it goes ahead.
    if ((endpoint.pausedUntil ?? 0) > now && (d.nextAttemptAt ?? 0) < endpoint.pausedUntil) {
      const job = await this.ctx.scheduler.runAt(endpoint.pausedUntil, refOf(o, "deliver"), { deliveryId } as never);
      await db.patch(deliveryId, { status: "pending", nextAttemptAt: endpoint.pausedUntil, job });
      return null;
    }
    const message = await db.get(d.messageId);
    if (!message) {
      await db.patch(deliveryId, { status: "failed", reason: "disabled", job: undefined });
      return null;
    }
    const attempt = d.attempts + 1;
    // If this attempt never settles (the process stopped mid-send), this job takes the delivery up again once the lease is over.
    const leaseUntil = now + o.timeoutMs + MINUTE;
    const job = await this.ctx.scheduler.runAt(leaseUntil, refOf(o, "deliver"), { deliveryId } as never);
    await db.patch(deliveryId, { status: "sending", attempts: attempt, leaseUntil, job, nextAttemptAt: undefined });
    const secrets = (endpoint.secrets as { secret: string; expiresAt?: number }[]).filter((s) => !s.expiresAt || s.expiresAt > now).map((s) => s.secret);
    return {
      attempt,
      url: endpoint.url,
      msgId: message.msgId,
      body: JSON.stringify({ type: message.type, timestamp: new Date(message.timestamp).toISOString(), data: message.data }),
      secrets,
    };
  }

  async settle(r: Outcome) {
    const o = this.options;
    const db = dbOf(this.ctx);
    const now = Date.now();
    const d = await db.get(r.deliveryId);
    if (!d || d.status !== "sending" || d.attempts !== r.attempt) return; // an attempt the lease already gave up on
    if (d.job) await this.ctx.scheduler.cancel(d.job);
    await db.insert("webhookAttempts", {
      deliveryId: r.deliveryId,
      endpointId: d.endpointId,
      attempt: r.attempt,
      at: now,
      durationMs: r.durationMs,
      statusCode: r.statusCode,
      error: r.error,
      response: r.response,
    });
    const last = { lastStatusCode: r.statusCode, lastError: r.error, leaseUntil: undefined, job: undefined };
    const endpoint = await db.get(d.endpointId);
    const ok = r.statusCode !== undefined && r.statusCode >= 200 && r.statusCode < 300;
    if (ok) {
      await db.patch(r.deliveryId, { ...last, status: "delivered", deliveredAt: now });
      if (endpoint?.failingSince !== undefined) await db.patch(d.endpointId, { failingSince: undefined });
      return;
    }
    if (r.blocked) return void (await db.patch(r.deliveryId, { ...last, status: "failed", reason: "blocked" }));
    if (r.statusCode === 410) {
      await db.patch(r.deliveryId, { ...last, status: "failed", reason: "rejected" });
      if (endpoint) await db.patch(d.endpointId, { disabled: true, disabledReason: "gone" });
      return;
    }
    if (endpoint) {
      const since = endpoint.failingSince ?? now;
      if (o.disableEndpointAfterMs !== false && now - since >= o.disableEndpointAfterMs) {
        await db.patch(d.endpointId, { disabled: true, disabledReason: "failing", failingSince: since });
        return void (await db.patch(r.deliveryId, { ...last, status: "failed", reason: "disabled" }));
      }
      if (endpoint.failingSince === undefined) await db.patch(d.endpointId, { failingSince: now });
    }
    if (r.attempt >= o.retry.attempts) return void (await db.patch(r.deliveryId, { ...last, status: "failed", reason: "exhausted" }));
    // Exponential backoff with equal jitter, at least what Retry-After asked for, never more than maxDelayMs.
    const base = Math.min(o.retry.maxDelayMs, o.retry.delayMs * o.retry.factor ** (r.attempt - 1));
    const delay = Math.min(o.retry.maxDelayMs, Math.max(base / 2 + (Math.random() * base) / 2, r.retryAfterMs ?? 0));
    if (endpoint && [429, 502, 503, 504].includes(r.statusCode ?? 0)) await db.patch(d.endpointId, { pausedUntil: now + delay });
    const job = await this.ctx.scheduler.runAfter(delay, refOf(o, "deliver"), { deliveryId: r.deliveryId } as never);
    await db.patch(r.deliveryId, { ...last, status: "pending", nextAttemptAt: now + delay, job });
  }
}

const retryAfterOf = (value: string | null) => {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
};

/** Sends one attempt: claim, check the destination, sign, POST, settle. Run by the scheduler through `webhookFunctions().deliver`. */
export class WebhookWorker extends ForgeService<ActionCtx> {
  protected readonly options!: Resolved;

  async deliver(deliveryId: string) {
    const o = this.options;
    const claimed = (await this.ctx.runMutation(refOf(o, "claim"), { deliveryId } as never)) as Claimed | null;
    if (!claimed) return;
    const started = performance.now();
    const outcome: Outcome = { deliveryId, attempt: claimed.attempt, durationMs: 0 };
    const to = await destinationOf(claimed.url, o);
    if ("blocked" in to) {
      outcome.blocked = true;
      outcome.error = `Destination blocked: ${to.blocked}`;
    } else if ("error" in to) {
      outcome.error = to.error;
    } else {
      const timestamp = Math.floor(Date.now() / 1000);
      try {
        const res = await sendTo(to, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "archlast-forge-webhooks",
            "webhook-id": claimed.msgId,
            "webhook-timestamp": String(timestamp),
            "webhook-signature": signWebhook({ id: claimed.msgId, timestamp, body: claimed.body, secrets: claimed.secrets }),
          },
          body: claimed.body,
          redirect: "manual", // a redirect is a failed attempt, never followed to somewhere unchecked
          signal: AbortSignal.timeout(o.timeoutMs),
        });
        outcome.statusCode = res.status;
        outcome.retryAfterMs = retryAfterOf(res.headers.get("retry-after"));
        const text = await res.text().catch(() => "");
        outcome.response = text.slice(0, o.maxResponseBytes) || undefined;
      } catch (e) {
        outcome.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      }
    }
    outcome.durationMs = Math.round(performance.now() - started);
    await this.ctx.runMutation(refOf(o, "settle"), outcome as never);
  }
}

/**
 * The functions the scheduler runs. Export them from the module named in `functions` (default forge/webhooks.ts):
 *
 *     export const { deliver, claim, settle } = webhookFunctions();
 *
 * All internal: clients can never call them.
 */
export function webhookFunctions() {
  const outcome = {
    deliveryId: v.string(),
    attempt: v.number(),
    durationMs: v.number(),
    statusCode: v.optional(v.number()),
    error: v.optional(v.string()),
    response: v.optional(v.string()),
    retryAfterMs: v.optional(v.number()),
    blocked: v.optional(v.boolean()),
  };
  return {
    deliver: internalAction({ args: { deliveryId: v.string() }, handler: async (ctx, { deliveryId }) => (await inject(ctx, WebhookWorker)).deliver(deliveryId) }),
    claim: internalMutation({ args: { deliveryId: v.string() }, handler: async (ctx, { deliveryId }) => (await inject(ctx, WebhookDeliveries)).claim(deliveryId) }),
    settle: internalMutation({ args: outcome, handler: async (ctx, r) => (await inject(ctx, WebhookDeliveries)).settle(r) }),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Receiving

/** What `@IncomingWebhook()` gives a handler once `@VerifyWebhook()` has checked the request. */
export interface IncomingWebhookData<T = unknown> {
  receiver: string;
  /** The webhook's id: what `webhookInbox.once()` deduplicates on. */
  id: string;
  /** When the sender signed it (ms), for schemes that sign a timestamp. */
  timestamp?: number;
  /** The body, parsed as JSON when it is JSON. */
  payload: T;
  rawBody: Buffer;
}

const RECEIVER = "archlast-forge:webhook-receiver";
const INCOMING = Symbol.for("archlast-forge.webhook.incoming");

/** Checks a request against the receiver named by `@VerifyWebhook()`: 401 when the signature or the timestamp is wrong. */
export class WebhookGuard implements CanActivate {
  protected readonly options!: Resolved;

  canActivate(context: ExecutionContext) {
    const name = (Reflect.getMetadata(RECEIVER, context.getHandler()) ?? Reflect.getMetadata(RECEIVER, context.getClass())) as string | undefined;
    const receiver = name === undefined ? undefined : this.options.receivers[name];
    if (!name || !receiver) throw new Error(`@VerifyWebhook("${name}"): no receiver of that name in WebhooksModule.forRoot({ receivers })`);
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; rawBody?: Buffer; [INCOMING]?: IncomingWebhookData }>();
    const rawBody = req.rawBody ?? Buffer.alloc(0);
    const configured = typeof receiver.secret === "function" ? receiver.secret() : receiver.secret;
    const secrets = [configured ?? []].flat().filter(Boolean) as string[];
    if (!secrets.length) throw new Error(`Webhook receiver "${name}" has no secret`);
    const scheme = receiver.scheme === undefined || receiver.scheme === "standard" ? standardScheme : receiver.scheme;
    const verified = scheme.verify({ headers: req.headers, rawBody }, secrets);
    if (!verified) throw new UnauthorizedException("Invalid webhook signature");
    const tolerance = receiver.toleranceMs ?? 5 * MINUTE;
    if (verified.timestamp !== undefined && Math.abs(Date.now() - verified.timestamp) > tolerance) throw new UnauthorizedException("Webhook timestamp is outside the tolerance");
    const text = rawBody.toString("utf8");
    let payload: unknown = text;
    try {
      payload = JSON.parse(text);
    } catch {}
    req[INCOMING] = { receiver: name, id: verified.id, timestamp: verified.timestamp, payload, rawBody };
    return true;
  }
}

/** On a controller method (or class): verify the request as receiver `name` sent it before the handler runs. */
export const VerifyWebhook = (name: string) => applyDecorators(SetMetadata(RECEIVER, name), UseGuards(WebhookGuard));

/** The verified webhook, in a handler that `@VerifyWebhook()` guards. */
export const IncomingWebhook = createParamDecorator((_data: unknown, host: ExecutionContext): IncomingWebhookData => {
  const incoming = host.switchToHttp().getRequest()[INCOMING];
  if (!incoming) throw new Error("@IncomingWebhook() needs @VerifyWebhook() on the same handler or its controller");
  return incoming;
});

/** The inbox, from the mutation that applies a webhook: `if (!(await this.inbox.once("payments", id))) return;` */
export class WebhookInbox extends ForgeService<MutationCtx> {
  /**
   * Records that `receiver`'s webhook `id` was applied, in this mutation's transaction, and says whether it is the first time. When the
   * mutation fails, the record goes with it and the sender's retry is applied.
   */
  async once(receiver: string, id: string): Promise<boolean> {
    const db = dbOf(this.ctx);
    const seen = await db.query("webhookInbox").withIndex("by_receiver_webhook", (q: any) => q.eq("receiver", receiver).eq("webhookId", id)).first();
    if (seen) return false;
    await db.insert("webhookInbox", { receiver, webhookId: id, receivedAt: Date.now() });
    return true;
  }

  /** Forgets ids older than `olderThanMs` (keep it longer than senders retry for: days). Returns how many went. */
  async prune(olderThanMs: number, limit = 500) {
    const db = dbOf(this.ctx);
    const cutoff = Date.now() - olderThanMs;
    const old: Doc[] = (await db.query("webhookInbox").take(limit)).filter((d: Doc) => d.receivedAt < cutoff);
    for (const d of old) await db.delete(d._id);
    return old.length;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The module

for (const c of [Webhooks, WebhookEndpoints, WebhookDeliveries, WebhookWorker, WebhookGuard]) {
  Injectable()(c);
  Inject(WEBHOOKS_OPTIONS)(c.prototype, "options");
}
for (const c of [WebhookLog, WebhookInbox]) Injectable()(c);

/**
 * `WebhooksModule.forRoot({ eventTypes, receivers, … })` in one feature module's `imports`. It is global: every module can inject
 * `Webhooks`, `WebhookEndpoints`, `WebhookLog` and `WebhookInbox`, and use `@VerifyWebhook()`.
 */
export class WebhooksModule {
  static forRoot(options: WebhooksOptions = {}): DynamicModule {
    const providers = [Webhooks, WebhookEndpoints, WebhookLog, WebhookDeliveries, WebhookWorker, WebhookInbox, WebhookGuard];
    return {
      module: WebhooksModule,
      global: true,
      providers: [{ provide: WEBHOOKS_OPTIONS, useValue: resolve(options) }, ...providers],
      exports: [WEBHOOKS_OPTIONS, ...providers],
    };
  }
}
Module({})(WebhooksModule);
