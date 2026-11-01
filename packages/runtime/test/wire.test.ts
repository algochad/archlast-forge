import { describe, expect, test } from "bun:test";
import { deserialize, serialize } from "bun:jsc";
import type { CallResult } from "../src/server/executor";
import { fromWire, lazyValue, toWire } from "../src/server/wire";

const result = (topics: string[]): CallResult => {
  const value = { beds: [{ id: 1, name: "ICU 1" }], note: null };
  return { value, topics, usedAuth: true, json: JSON.stringify(value), telemetry: undefined };
};
// What actually happens to it: serialized in the runtime process, deserialized in the server.
const cross = (r: CallResult) => fromWire(deserialize(serialize(toWire(r)))) as CallResult;

describe("a result crossing between processes", () => {
  test("carries its JSON, not the object, and the object comes back from the JSON when asked", () => {
    const sent = toWire(result(["a:by_id:[1]"])) as Record<string, unknown>;
    expect(sent.value).toBeUndefined();
    expect("value" in sent).toBe(false);
    const got = cross(result(["a:by_id:[1]"]));
    expect(got.value).toEqual({ beds: [{ id: 1, name: "ICU 1" }], note: null });
    expect(got.usedAuth).toBe(true);
    expect(got.json).toBe('{"beds":[{"id":1,"name":"ICU 1"}],"note":null}');
  });

  test("parses the object once, only when it is read, and spreads and stringifies leave it out", () => {
    const got = cross(result([]));
    expect(Object.keys(got)).not.toContain("value");
    expect(JSON.parse(JSON.stringify(got))).not.toHaveProperty("value");
    expect({ ...got }).not.toHaveProperty("value");
    expect(got.value).toBe(got.value); // the same object each time
  });

  test("many topics cross as one string and come back as the same array", () => {
    const topics = Array.from({ length: 5000 }, (_, i) => `admissions:by_id:["admissions:${i}"]`);
    const sent = toWire(result(topics)) as Record<string, unknown>;
    expect(typeof sent.topicsText).toBe("string");
    expect(sent.topics).toBeUndefined();
    expect(cross(result(topics)).topics).toEqual(topics);
  });

  test("few topics stay an array, and topics that can't be joined safely do too", () => {
    expect((toWire(result(["a", "b"])) as Record<string, unknown>).topics).toEqual(["a", "b"]);
    const odd = Array.from({ length: 40 }, (_, i) => (i === 7 ? "has\na newline" : `t${i}`));
    const sent = toWire(result(odd)) as Record<string, unknown>;
    expect(sent.topicsText).toBeUndefined();
    expect(cross(result(odd)).topics).toEqual(odd);
  });

  test("a call with no topics, and results that are not calls, pass through unchanged", () => {
    const none = cross({ value: 1, json: "1" });
    expect(none.topics).toBeUndefined();
    expect(none.value).toBe(1);
    const other = { status: 200, headers: [], body: new ArrayBuffer(2) };
    expect(toWire(other as unknown as CallResult)).toBe(other);
    expect(fromWire(other)).toBe(other);
    expect(fromWire(null)).toBeNull();
    expect(fromWire("text")).toBe("text");
  });

  test("a result whose value is null (a function that returned nothing) parses to null", () => {
    expect(cross({ value: null, json: "null", topics: [] }).value).toBeNull();
  });
});

test("lazyValue computes once and hides itself from JSON", () => {
  let calls = 0;
  const o = lazyValue({ json: "{}" }, () => (calls++, { made: true }));
  expect(calls).toBe(0);
  expect(o.value).toEqual({ made: true });
  expect(o.value).toBe(o.value);
  expect(calls).toBe(1);
  expect(JSON.stringify(o)).toBe('{"json":"{}"}');
});
