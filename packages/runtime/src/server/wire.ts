// How a function call's result crosses from a function-runtime process to the server, and how the server's results get their `value`.
import type { CallResult } from "./executor";

/** A topic list this long crosses as one string: an array of thousands of strings costs more to move than the JSON beside it. */
const PACK_FROM = 32;

/** Adds `value` to `target` as a property that is computed on first read, once, and that spreads and JSON.stringify leave out. */
export function lazyValue<T extends object>(target: T, get: () => unknown): T & { value: unknown } {
  let done = false;
  let value: unknown;
  Object.defineProperty(target, "value", { enumerable: false, configurable: true, get: () => (done ? value : ((done = true), (value = get()))) });
  return target as T & { value: unknown };
}

/**
 * A result as it leaves the process: its JSON text and its topics, without the object. The server answers with the text and never needs the
 * object unless something asks (`fromWire` parses it then), and moving the object tree too made a large result several times dearer to send and
 * to receive. Topics are joined into one string when there are many (they are built with JSON.stringify, so none holds a newline).
 */
export function toWire(result: CallResult): unknown {
  if (typeof result?.json !== "string") return result;
  const { value: _object, topics, ...rest } = result;
  const wire: Record<string, unknown> = { ...rest, wire: 1 };
  if (topics) {
    if (topics.length >= PACK_FROM && !topics.some((t) => t.includes("\n"))) wire.topicsText = topics.join("\n");
    else wire.topics = topics;
  }
  return wire;
}

/** The reverse, on the server: topics are an array again and `value` parses from the JSON text when first read. Anything that isn't a wire result passes through. */
export function fromWire(message: unknown): unknown {
  const wire = message as (Partial<CallResult> & { wire?: number; topicsText?: string }) | null | undefined;
  if (!wire || typeof wire !== "object" || wire.wire !== 1) return message;
  delete wire.wire;
  if (typeof wire.topicsText === "string") {
    wire.topics = wire.topicsText.split("\n");
    delete wire.topicsText;
  }
  return lazyValue(wire as { json: string }, () => JSON.parse(wire.json!));
}
