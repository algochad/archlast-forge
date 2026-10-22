import type { ServerWebSocket } from "bun";
import { EventEmitter } from "node:events";

/** The subset of the `ws` package's socket that tRPC's connection handler uses, over Bun's ServerWebSocket. */
export class WsShim extends EventEmitter {
  readyState = 1;

  constructor(private ws: ServerWebSocket<unknown>) {
    super();
  }

  send(data: string) {
    this.ws.send(data);
  }

  close(code?: number, reason?: string) {
    this.ws.close(code, reason);
  }

  terminate() {
    this.ws.terminate();
  }
}

export interface WsData {
  req: { url: string; headers: Record<string, string> };
  shim?: WsShim;
}
