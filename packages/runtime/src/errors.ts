/**
 * An error meant for the caller: its message and `data` reach the client unchanged.
 * Any other error thrown by a function is reported as "Server error" outside dev, with a request id to find it in the logs.
 */
export class ForgeError<T = string> extends Error {
  override name = "ForgeError";
  readonly data: T;

  constructor(data: T) {
    super(typeof data === "string" ? data : JSON.stringify(data));
    this.data = data;
  }
}

/** By name, so it works across module copies and process boundaries. */
export const isForgeError = (e: unknown): e is ForgeError<unknown> => (e as Error)?.name === "ForgeError";

export class TimeoutError extends Error {
  override name = "TimeoutError";
}
