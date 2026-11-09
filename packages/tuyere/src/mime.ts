import { isUtf8 } from "node:buffer";

/**
 * The Content-Type Bun gives a body that has none: images by their first bytes, valid UTF-8 text without NUL as
 * text/plain, everything else application/octet-stream. (Bun also knows whether a body started as a string, which a
 * stream of bytes can't tell; text bytes are treated as text.)
 */
export function inferContentType(body: Uint8Array): string {
  const n = body.length;
  if (
    n >= 8 &&
    body[0] === 0x89 &&
    body[1] === 0x50 &&
    body[2] === 0x4e &&
    body[3] === 0x47
  )
    return "image/png";
  if (n >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff)
    return "image/jpeg";
  if (
    n >= 4 &&
    body[0] === 0x47 &&
    body[1] === 0x49 &&
    body[2] === 0x46 &&
    body[3] === 0x38
  )
    return "image/gif";
  if (n >= 2 && body[0] === 0x42 && body[1] === 0x4d) return "image/bmp";
  if (
    n >= 4 &&
    ((body[0] === 0x49 &&
      body[1] === 0x49 &&
      body[2] === 0x2a &&
      body[3] === 0) ||
      (body[0] === 0x4d &&
        body[1] === 0x4d &&
        body[2] === 0 &&
        body[3] === 0x2a))
  )
    return "image/tiff";
  if (isUtf8(body) && !body.includes(0)) return "text/plain;charset=utf-8";
  return "application/octet-stream";
}

/** Statuses whose responses carry no representation (and so no Content-Type). */
export function bodyless(status: number): boolean {
  return (
    status < 200 ||
    status === 204 ||
    status === 205 ||
    status === 304 ||
    (status >= 300 && status < 400)
  );
}
