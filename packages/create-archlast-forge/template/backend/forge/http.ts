import { httpAction, httpRouter } from "@archlast/forge-runtime";

// Plain HTTP routes, served under /http: this one answers GET /http/hello.
// Use them for webhooks and public APIs; everything else should be a query or mutation.
const http = httpRouter();

http.route({
  method: "GET",
  path: "/hello",
  handler: httpAction(async () => Response.json({ message: "Hello from __NAME__" })),
});

export default http;
