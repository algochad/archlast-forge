// A production-built starter app, served by the real engine on a fixed port, for profiling a page request.
//   BUILD=1 bun bench/profile.ts                 builds the starter into test/.tmp and remembers where
//   bun [--cpu-prof-md] bench/profile.ts         serves it on :17020, prints "ready"; EXIT_AFTER=<s> exits (a profile is written on exit)
// The session cookie it prints into <app>/cookie.txt signs requests in as a user (for /chat). Load: oha -c 64 -H "cookie: …" http://127.0.0.1:17020/
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { codegen } from "../../cli/src/codegen";
import { buildApp } from "../src/build";
import { startFixture, signUp } from "../test/helpers";
import { templateProject } from "../test/template";

const marker = join(import.meta.dir, "../test/.tmp/prof-root.txt");
let dir: string;
if (process.env.BUILD) {
  dir = templateProject("prof", "framework", []);
  await codegen(join(dir, "forge"));
  await buildApp({ root: dir, dev: false });
  writeFileSync(marker, dir);
  console.log("built", dir);
  process.exit(0);
}
dir = (await Bun.file(marker).text()).trim();
const srv = await startFixture({
  root: dir,
  env: { PORT: "17020", LOG_LEVEL: "warn" },
});
const cookie = await signUp(srv, "a@b.co");
writeFileSync(join(dir, "cookie.txt"), cookie);
console.log("ready", srv.url);
setInterval(() => {}, 1e6);
if (process.env.EXIT_AFTER)
  setTimeout(() => process.exit(0), Number(process.env.EXIT_AFTER) * 1000);
