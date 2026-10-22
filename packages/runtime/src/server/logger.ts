export type LogLevel = "debug" | "info" | "warn" | "error";

let format: "pretty" | "json" = "pretty";
export const setLogFormat = (f: "pretty" | "json") => (format = f);

/** Server log line: one JSON object per line in production, readable text in dev. */
export function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}) {
  const out = level === "error" || level === "warn" ? console.error : console.log;
  if (format === "json") out(JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }));
  else {
    const extra = Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
    out(`${level === "error" ? "✗" : level === "warn" ? "!" : "·"} ${msg}${extra ? `  ${extra}` : ""}`);
  }
}
