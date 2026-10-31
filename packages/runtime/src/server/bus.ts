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

const TOPIC = "archlast-forge:t:";
const ALL = "archlast-forge:all";

/**
 * Redis pub/sub across servers, one channel per topic: a server receives only topics it has subscribers for.
 * Wildcard listeners (the query cache) use a separate all-topics channel, published only when `broadcastAll` is on.
 * Fire-and-forget: clients refetch on reconnect.
 */
export class RedisBus extends MemoryBus {
  private pending = new Map<string, Promise<unknown>>();

  private constructor(
    private pub: RedisClient,
    private sub: RedisClient,
    private broadcastAll: boolean,
  ) {
    super();
  }

  static async connect(url: string, opts: { broadcastAll?: boolean } = {}) {
    const pub = await connectRedis(url);
    return new RedisBus(pub, await pub.duplicate(), opts.broadcastAll ?? false);
  }

  override subscribe(topic: string, listener: TopicListener) {
    const first = !this.hasListeners(topic);
    const off = super.subscribe(topic, listener);
    if (first) {
      const channel = topic === "*" ? ALL : TOPIC + topic;
      const p = this.sub.subscribe(channel, (message) => {
        if (topic === "*") for (const t of JSON.parse(message) as string[]) this.deliver("*", t);
        else this.deliver(topic, topic);
      });
      this.pending.set(topic, p.catch((e) => console.error(`redis subscribe ${channel} failed:`, e)));
    }
    return () => {
      off();
      if (!this.hasListeners(topic)) {
        const channel = topic === "*" ? ALL : TOPIC + topic;
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
      ...topics.map((t) => this.pub.publish(TOPIC + t, "1")),
      ...(this.broadcastAll && topics.length ? [this.pub.publish(ALL, JSON.stringify(topics))] : []),
    ]);
  }

  override async close() {
    this.sub.close();
    this.pub.close();
  }
}
