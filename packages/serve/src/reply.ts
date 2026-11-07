import type { HeaderInit } from "./codec.ts";
import { Reply } from "./server.ts";

type Init = { status?: number; headers?: HeaderInit };

/** `headers` plus `name: value` unless a header of that name (any case) is already there. */
function withDefault(headers: HeaderInit | undefined, name: string, value: string): [string, string][] {
    const pairs: [string, string][] = headers === undefined ? [] : Array.isArray(headers) ? [...headers] : Object.entries(headers);
    if (!pairs.some(([k]) => k.toLowerCase() === name)) pairs.push([name, value]);
    return pairs;
}

/** Any status with an optional body, e.g. `status(418, "short and stout")`. */
export function status(code: number, body: string | Uint8Array | null = null, init: Omit<Init, "status"> = {}): Reply {
    return new Reply(body, { status: code, headers: init.headers });
}

/** JSON body with `content-type: application/json`. */
export function json(data: unknown, init: Init = {}): Reply {
    return new Reply(JSON.stringify(data), { status: init.status, headers: withDefault(init.headers, "content-type", "application/json;charset=utf-8") });
}

export function text(body: string, init: Init = {}): Reply {
    return new Reply(body, { status: init.status, headers: withDefault(init.headers, "content-type", "text/plain;charset=utf-8") });
}

export function html(body: string, init: Init = {}): Reply {
    return new Reply(body, { status: init.status, headers: withDefault(init.headers, "content-type", "text/html;charset=utf-8") });
}

/** 301, 302 (default), 303, 307 or 308 with a `Location` header. */
export function redirect(location: string, code: 301 | 302 | 303 | 307 | 308 = 302, init: Omit<Init, "status"> = {}): Reply {
    if (/[\r\n]/.test(location)) throw new RangeError("redirect location must not contain line breaks");
    return new Reply(null, { status: code, headers: withDefault(init.headers, "location", location) });
}

/** 204 No Content. */
export function noContent(init: Omit<Init, "status"> = {}): Reply {
    return new Reply(null, { status: 204, headers: init.headers });
}
