import { RedisClient } from "bun";

export type TopicListener = (topic: string) => void;

export interface Bus {
  /** Call only after the writing transaction commits. */
  publish(topics: string[]): Promise<void>;
  /** "*" receives every topic. Returns an unsubscribe function. */
  subscribe(topic: string, listener: TopicListener): () => void;
  /** Resolves once subscriptions made so far are live (remote buses subscribe asynchronously). */
  ready?(): Promise<unknown>;
  close(): Promise<void>;
}

/** Single-process bus. */
export class MemoryBus implements Bus {
  private listeners = new Map<string, Set<TopicListener>>();

  async publish(topics: string[]) {
    this.dispatch(topics);
  }

  subscribe(topic: string, listener: TopicListener) {
    let set = this.listeners.get(topic);
    if (!set) this.listeners.set(topic, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(topic);
    };
  }

  protected dispatch(topics: string[]) {
    for (const t of topics) {
      this.deliver(t, t);
      this.deliver("*", t);
    }
  }

  protected deliver(key: string, topic: string) {
    for (const l of this.listeners.get(key) ?? []) l(topic);
  }

  protected hasListeners(key: string) {
    return this.listeners.has(key);
  }

  async close() {}
}

/** Connects once without retries so an unreachable REDIS_URL fails startup instead of hanging. */
export async function connectRedis(url: string) {
  const probe = new RedisClient(url, { connectionTimeout: 3000, autoReconnect: false });
  try {
    await probe.connect();
  } catch (e) {
    throw new Error(`REDIS_URL is set but Redis is unreachable: ${(e as Error).message}`);
  } finally {
    probe.close();
  }
  const client = new RedisClient(url);
  await client.connect();
  return client;
}

/**
 * Notes which app uses a prefix, and says when another one already does: two apps that share a Redis and a prefix share a cache and wake each
 * other's subscriptions. Each start writes its own mark over the last, so a secret that was rotated settles after one start and a real clash
 * keeps being reported. Returns true when the mark was another app's. Never throws: Redis not answering is for the connection to report.
 */
export async function claimPrefix(redis: RedisClient, prefix: string, owner: string): Promise<boolean> {
  try {
    const key = `${prefix}owner`;
    const was = await answered(redis.get(key));
    await answered(redis.send("SET", [key, owner]));
    return was != null && was !== owner;
  } catch {
    return false;
  }
}

/** A Redis command on a request's path: rejects after `ms` rather than waiting out a reconnect, which Bun's client queues commands for. */
export function answered<T>(command: Promise<T>, ms = 1000): Promise<T> {
  let timer: Timer;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`Redis didn't answer within ${ms} ms`)), ms)));
  return Promise.race([command, late]).finally(() => clearTimeout(timer));
}

/**
 * What every Redis key and channel of the engine starts with. Servers of one app share a prefix; apps that share a Redis must not (config.ts
 * derives one per app, or REDIS_PREFIX sets it), or one app's cached results, topics and rate limits would be another's. This value, with
 * nothing after it, is what the engine used before the prefix could be chosen.
 */
export const DEFAULT_REDIS_PREFIX = "archlast-forge:";

/**
 * Redis pub/sub across servers, one channel per topic: a server receives only topics it has subscribers for.
 * Wildcard listeners (the query cache) use a separate all-topics channel, published only when `broadcastAll` is on.
 * Fire-and-forget: clients refetch on reconnect.
 */
export class RedisBus extends MemoryBus {
  private pending = new Map<string, Promise<unknown>>();

  /** One channel per topic, and the all-topics channel, below this app's prefix. */
  private readonly topicChannel: string;
  private readonly allChannel: string;

  private constructor(
    private pub: RedisClient,
    private sub: RedisClient,
    private broadcastAll: boolean,
    prefix: string,
  ) {
    super();
    this.topicChannel = `${prefix}t:`;
    this.allChannel = `${prefix}all`;
  }

  static async connect(url: string, opts: { broadcastAll?: boolean; prefix?: string } = {}) {
    const pub = await connectRedis(url);
    return new RedisBus(pub, await pub.duplicate(), opts.broadcastAll ?? false, opts.prefix ?? DEFAULT_REDIS_PREFIX);
  }

  override subscribe(topic: string, listener: TopicListener) {
    const first = !this.hasListeners(topic);
    const off = super.subscribe(topic, listener);
    if (first) {
      const channel = topic === "*" ? this.allChannel : this.topicChannel + topic;
      const p = this.sub.subscribe(channel, (message) => {
        if (topic === "*") for (const t of JSON.parse(message) as string[]) this.deliver("*", t);
        else this.deliver(topic, topic);
      });
      this.pending.set(topic, p.catch((e) => console.error(`redis subscribe ${channel} failed:`, e)));
    }
    return () => {
      off();
      if (!this.hasListeners(topic)) {
        const channel = topic === "*" ? this.allChannel : this.topicChannel + topic;
        // A channel left subscribed only delivers topics nobody listens to; and close() rejects an unsubscribe still in flight.
        void (this.pending.get(topic) ?? Promise.resolve()).then(() => (this.hasListeners(topic) ? undefined : this.sub.unsubscribe(channel))).catch(() => {});
        this.pending.delete(topic);
      }
    };
  }

  /** Resolves once Redis has confirmed every subscription made so far. */
  ready() {
    return Promise.all(this.pending.values());
  }

  override async publish(topics: string[]) {
    await Promise.all([
      ...topics.map((t) => this.pub.publish(this.topicChannel + t, "1")),
      ...(this.broadcastAll && topics.length ? [this.pub.publish(this.allChannel, JSON.stringify(topics))] : []),
    ]);
  }

  override async close() {
    this.sub.close();
    this.pub.close();
  }
}
