import { httpRouter, minimalAction, minimalJson, MinimalResponse, minimalText } from "@archlast/forge-runtime";
import { nest } from "@archlast/forge-runtime/nest";
import { ApiController } from "./api.controller";

const http = httpRouter({ root: true });
const get = (path: string, handler: Parameters<typeof minimalAction>[0]) => http.route({ method: "GET", path, handler: minimalAction(handler) });

get("/runtime", () => Response.json({ path: import.meta.resolve("@archlast/forge-runtime"), pid: process.pid }));
get("/json", () =>
  minimalJson({ created: true }, 201, [
    ["set-cookie", "a=1; Path=/"],
    ["set-cookie", "b=2; Path=/"],
  ]),
);
get("/text", async () => minimalText("héllo"));
get("/binary", () => new MinimalResponse(200, [["content-type", "application/octet-stream"]], new Uint8Array([0, 255, 128, 10])));
get("/empty", () => new MinimalResponse(204, [["x-empty", "yes"]], null));
get("/cached", () => new MinimalResponse(304, [["etag", '"v1"']], null));
get("/redirect", () => new MinimalResponse(307, [["location", "/text"]], null));
get("/native", () => new Response("native", { status: 202, headers: { "x-native": "yes" } }));
get("/invalid", () => ({ status: 200, headers: [], body: "internal fixture detail" }) as unknown as MinimalResponse);
get("/throws", () => {
  throw new Error("internal fixture detail");
});

let finishStream: (() => void) | undefined;
get("/stream", () => {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode("data: first\n\n"));
        await new Promise<void>((resolve) => {
          finishStream = resolve;
        });
        controller.enqueue(encoder.encode("data: last\n\n"));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
});
get("/finish-stream", () => {
  finishStream?.();
  return new Response(null, { status: 204 });
});

nest(http, {
  prefix: "/api/",
  controllers: [ApiController],
  cors: { origin: "https://app.example", credentials: true },
  helmet: { referrerPolicy: { policy: "same-origin" } },
});

export default http;
