import { afterAll, beforeAll, expect, test } from "bun:test";
import { destinationOf, sendTo } from "../src/webhook-destination";

// Where an outgoing webhook may connect, with a stub resolver in place of DNS.
const rules = { allowHttp: true, allowPrivateNetworks: false, allowedAddresses: [] as string[] };
const resolvesTo = (...addresses: string[]) => async () => addresses.map((address) => ({ address }));

test("a host whose lookup fails is not called: the attempt fails, and isn't blocked for good", async () => {
  const d = await destinationOf("https://hooks.example/in", rules, async () => {
    throw Object.assign(new Error("queryA ESERVFAIL hooks.example"), { code: "ESERVFAIL" });
  });
  expect(d).toEqual({ error: "Could not resolve hooks.example: queryA ESERVFAIL hooks.example" });
});

test("the unspecified address, NAT64 addresses of private or metadata IPv4, and site-local IPv6 are blocked", async () => {
  const blocked = async (ip: string, o = rules) => ((await destinationOf("https://hooks.example/in", o, resolvesTo(ip))) as { blocked?: string }).blocked;
  expect(await blocked("::")).toContain("link-local or a metadata service");
  expect(await blocked("64:ff9b::a9fe:a9fe")).toBe("the address 169.254.169.254 is link-local or a metadata service");
  expect(await blocked("64:ff9b::169.254.169.254")).toBe("the address 169.254.169.254 is link-local or a metadata service");
  expect(await blocked("64:ff9b::7f00:1")).toBe("the address 127.0.0.1 is private");
  expect(await blocked("64:ff9b::a00:1")).toBe("the address 10.0.0.1 is private");
  expect(await blocked("fec0::1")).toBe("the address fec0::1 is private");
  // A public address behind NAT64 is still fine, and private networks can still be allowed (not metadata).
  expect(await blocked("64:ff9b::5db8:d70e")).toBeUndefined();
  expect(await blocked("64:ff9b::7f00:1", { ...rules, allowPrivateNetworks: true })).toBeUndefined();
  expect(await blocked("64:ff9b::a9fe:a9fe", { ...rules, allowPrivateNetworks: true })).toBeDefined();
});

test("one address of several that is private blocks the host", async () => {
  expect(await destinationOf("https://hooks.example/in", rules, resolvesTo("93.184.215.14", "10.1.2.3"))).toEqual({ blocked: "the address 10.1.2.3 is private" });
});

// The request goes to the address that was checked, never to whatever a second lookup of the name returns (DNS rebinding).
let receiver: ReturnType<typeof Bun.serve>;
const got: { host: string | null; path: string }[] = [];
beforeAll(() => {
  receiver = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      got.push({ host: req.headers.get("host"), path: new URL(req.url).pathname });
      return new Response("ok");
    },
  });
});
afterAll(() => receiver.stop(true));

test("the request connects to the checked address, with the URL's host as Host", async () => {
  const lookups: string[] = [];
  // A name nothing else resolves: if anything looked it up again, the request couldn't arrive.
  const d = await destinationOf(`http://hooks.invalid:${receiver.port}/in`, { ...rules, allowPrivateNetworks: true }, async (host) => (lookups.push(host), [{ address: "127.0.0.1" }]));
  if (!("url" in d)) throw new Error(JSON.stringify(d));
  const res = await sendTo(d, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(await res.text()).toBe("ok");
  expect(lookups).toEqual(["hooks.invalid"]);
  expect(got.at(-1)).toEqual({ host: `hooks.invalid:${receiver.port}`, path: "/in" });
});

test("an address that refuses the connection gives way to the next checked one", async () => {
  const d = await destinationOf(`http://hooks.invalid:${receiver.port}/next`, { ...rules, allowPrivateNetworks: true }, resolvesTo("::1", "127.0.0.1"));
  if (!("url" in d)) throw new Error(JSON.stringify(d));
  expect((await sendTo(d, { method: "POST", headers: {}, body: "{}" })).status).toBe(200);
  expect(got.at(-1)?.path).toBe("/next");
});
