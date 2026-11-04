// The wire format of Forge RPC: tRPC v11's HTTP batch protocol (MIT, https://github.com/trpc/trpc; see THIRD_PARTY_NOTICES.md), so a stock
// tRPC client or server can still talk to this one. A call is `POST /<router>.<method>` with the input as the body; calls made together are
// `POST /a.b,c.d?batch=1` with `{"0": input, "1": input}`, answered by an array in the same order: `{"result":{"data":…}}` or
// `{"error":{"message","code","data":{"code","httpStatus","path","requestId"?,"data"?}}}`. The status is the common one, or 207.

/** JSON-RPC code and HTTP status of every error code a Forge RPC server answers with. */
export const CODES: Record<string, readonly [rpc: number, http: number]> = {
  PARSE_ERROR: [-32700, 400],
  BAD_REQUEST: [-32600, 400],
  UNAUTHORIZED: [-32001, 401],
  FORBIDDEN: [-32003, 403],
  NOT_FOUND: [-32004, 404],
  METHOD_NOT_SUPPORTED: [-32005, 405],
  TIMEOUT: [-32008, 408],
  CONFLICT: [-32009, 409],
  PRECONDITION_FAILED: [-32012, 412],
  PAYLOAD_TOO_LARGE: [-32013, 413],
  UNPROCESSABLE_CONTENT: [-32022, 422],
  TOO_MANY_REQUESTS: [-32029, 429],
  INTERNAL_SERVER_ERROR: [-32603, 500],
  NOT_IMPLEMENTED: [-32603, 501],
  SERVICE_UNAVAILABLE: [-32603, 503],
};

/** A call that failed in a way the caller is told about. Not an Error: no stack is captured on a path that may be hot. */
export class RpcFailure {
  constructor(
    readonly code: string,
    readonly message: string,
    readonly data?: unknown,
    readonly requestId?: string,
  ) {}
}

/** An error as it crosses the wire to the caller (the shape Nest's ClientProxy hands to `catchError`). */
export interface WireError {
  status: "error";
  message: string;
  code: string;
  data?: unknown;
  requestId?: string;
}
