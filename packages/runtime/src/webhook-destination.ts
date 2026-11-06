// Where an outgoing webhook may go (nest-webhooks.ts): the destination's host is resolved once, every address is checked, and the request
// connects to those addresses with the host named for TLS and Host, so a second lookup (DNS rebinding) can't send it somewhere unchecked.
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/** What `webhooks({...})` says about destinations. */
export interface DestinationRules {
  allowHttp: boolean;
  allowPrivateNetworks: boolean;
  allowedAddresses: string[];
}

type Resolve = (host: string) => Promise<{ address: string }[]>;

// Addresses no webhook may reach: link-local (and the cloud metadata service on it) always; private, loopback and shared ranges unless allowed.
const alwaysBlocked = new BlockList();
alwaysBlocked.addSubnet("169.254.0.0", 16, "ipv4");
alwaysBlocked.addSubnet("fe80::", 10, "ipv6");
alwaysBlocked.addAddress("fd00:ec2::254", "ipv6");
alwaysBlocked.addSubnet("0.0.0.0", 8, "ipv4");
alwaysBlocked.addAddress("::", "ipv6"); // like 0.0.0.0, it reaches this host
const privateRanges = new BlockList();
for (const [a, bits] of [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["127.0.0.0", 8], ["100.64.0.0", 10]] as const) privateRanges.addSubnet(a, bits, "ipv4");
privateRanges.addAddress("::1", "ipv6");
privateRanges.addSubnet("fc00::", 7, "ipv6");
privateRanges.addSubnet("fec0::", 10, "ipv6"); // the old site-local range

const familyOf = (ip: string) => (isIP(ip) === 6 ? "ipv6" : "ipv4");
const unmapped = (ip: string) => (ip.toLowerCase().startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip);
const nat64Prefix = new BlockList();
nat64Prefix.addSubnet("64:ff9b::", 96, "ipv6");
/** The IPv4 address a NAT64 address (64:ff9b::/96) reaches, which is what it must be checked as; any other address as it is. */
function nat64(ip: string) {
  if (familyOf(ip) !== "ipv6" || !nat64Prefix.check(ip, "ipv6")) return ip;
  const tail = ip.slice(ip.lastIndexOf(":") + 1);
  if (isIP(tail) === 4) return tail;
  const [hi, lo] = ip.split(":").slice(-2).map((h) => parseInt(h || "0", 16));
  const n = ((hi! << 16) | lo!) >>> 0;
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/** Where an attempt connects: the addresses its host resolved to, all of them checked, so the request can't go anywhere a second lookup chose. */
export type Destination = { url: URL; addresses: string[] } | { blocked: string } | { error: string };

/** Resolves a URL's host once and checks every address it has (on every attempt): the request then goes to those addresses only. */
export async function destinationOf(url: string, o: DestinationRules, resolve: Resolve = (host) => lookup(host, { all: true })): Promise<Destination> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { blocked: "not a URL" };
  }
  if (u.protocol !== "https:" && !(o.allowHttp && u.protocol === "http:")) return { blocked: "not https" };
  const host = u.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : (await resolve(host)).map((a) => a.address);
  } catch (e) {
    // Not sent: a host that can't be checked isn't called. A failed attempt, retried like any other.
    return { error: `Could not resolve ${host}: ${(e as Error).message}` };
  }
  if (!addresses.length) return { error: `Could not resolve ${host}` };
  const allowed = new BlockList();
  for (const a of o.allowedAddresses) {
    const [ip, bits] = a.split("/");
    if (bits) allowed.addSubnet(ip!, Number(bits), familyOf(ip!));
    else allowed.addAddress(ip!, familyOf(ip!));
  }
  for (const raw of addresses) {
    const ip = nat64(unmapped(raw));
    const family = familyOf(ip);
    if (alwaysBlocked.check(ip, family)) return { blocked: `the address ${ip} is link-local or a metadata service` };
    if (!o.allowPrivateNetworks && privateRanges.check(ip, family) && !allowed.check(ip, family)) return { blocked: `the address ${ip} is private` };
  }
  return { url: u, addresses };
}

/** Sends to the checked addresses in turn, the next only when one refuses the connection (nothing was sent), naming the host for TLS and Host. */
export async function sendTo(d: { url: URL; addresses: string[] }, init: RequestInit & { headers: Record<string, string> }): Promise<Response> {
  const host = d.url.hostname.replace(/^\[|\]$/g, "");
  let last: unknown;
  for (const ip of d.addresses) {
    const target = new URL(d.url);
    target.hostname = isIP(ip) === 6 ? `[${ip}]` : ip;
    try {
      return await fetch(target, {
        ...init,
        headers: { ...init.headers, host: d.url.host },
        ...(d.url.protocol === "https:" && !isIP(host) && { tls: { serverName: host } }),
      });
    } catch (e) {
      last = e;
      if (!["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL"].includes((e as { code?: string }).code ?? "")) throw e;
    }
  }
  throw last;
}
