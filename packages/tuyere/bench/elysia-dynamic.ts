import { Elysia } from "elysia";
new Elysia()
  .get("/", () => "hello")
  .get("/json", () => ({ ok: true, n: 42 }))
  .listen(Number(process.env.PORT));
console.log("listening", process.env.PORT);
