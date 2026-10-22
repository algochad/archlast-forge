import { RedisClient } from "bun";

export type TopicListener = (topic: string) => void;

export interface Bus {
  /** Call only after the writing transaction commits. */
  publish(topics: string[]): Promise<void>;
  /** "*" receives every topic. Returns an unsubscribe function. */
  subscribe(topic: string, listener: TopicListener): () => void;
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
    const all = this.listeners.get("*");
    for (const t of topics) {
      for (const l of this.listeners.get(t) ?? []) l(t);
      for (const l of all ?? []) l(t);
    }
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

const CHANNEL = "archlast-forge:topics";

/**
 * Redis pub/sub across servers. Fire-and-forget: clients refetch on reconnect.
 * shortcut: one channel carries every topic and each server filters locally; switch to per-topic channels if fan-out traffic gets heavy.
 */
export class RedisBus extends MemoryBus {
  private constructor(
    private pub: RedisClient,
    private sub: RedisClient,
  ) {
    super();
  }

  static async connect(url: string) {
    const pub = await connectRedis(url);
    const sub = await pub.duplicate();
    const bus = new RedisBus(pub, sub);
    await sub.subscribe(CHANNEL, (message) => bus.dispatch(JSON.parse(message)));
    return bus;
  }

  override async publish(topics: string[]) {
    if (topics.length) await this.pub.publish(CHANNEL, JSON.stringify(topics));
  }

  override async close() {
    this.sub.close();
    this.pub.close();
  }
}
