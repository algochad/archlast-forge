// args: s0 s1 clientJson seconds label   -> per-thread CPU per message
import { readFileSync } from "node:fs";
const rd = (f: string) =>
  Object.fromEntries(
    readFileSync(f, "utf8")
      .trim()
      .split("\n")
      .map((l, i) => {
        const [n, u, s] = l.split(" ");
        return [`${i}:${n}`, [+u, +s]];
      }),
  );
const [f0, f1, json, secs, label] = process.argv.slice(2);
const a = rd(f0),
  b = rd(f1),
  j = JSON.parse(json),
  msgs = j.msgs_per_sec * Number(secs);
let tu = 0,
  ts = 0;
console.log(label, "msgs/s", Math.round(j.msgs_per_sec));
for (const k of Object.keys(b)) {
  const du = (b[k][0] - (a[k]?.[0] ?? 0)) * 10,
    ds = (b[k][1] - (a[k]?.[1] ?? 0)) * 10;
  tu += du;
  ts += ds;
  if (du + ds > 50)
    console.log(
      "  ",
      k.padEnd(24),
      "user",
      ((du * 1e6) / msgs).toFixed(0).padStart(5),
      "sys",
      ((ds * 1e6) / msgs).toFixed(0).padStart(5),
      "ns/msg",
    );
}
console.log(
  "   total ns/msg: user",
  ((tu * 1e6) / msgs).toFixed(0),
  "sys",
  ((ts * 1e6) / msgs).toFixed(0),
  " =>",
  (((tu + ts) * 1e6) / msgs).toFixed(0),
);
