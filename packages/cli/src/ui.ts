// Terminal output: colors when there's a terminal to show them, and a spinner that becomes plain lines in logs and CI.

const tty = Boolean(process.stdout.isTTY);
const color = (tty && !process.env.NO_COLOR && process.env.TERM !== "dumb") || Boolean(process.env.FORCE_COLOR);
const wrap = (open: number, close: number) => (s: string) => (color ? `\x1b[${open}m${s}\x1b[${close}m` : s);

export const c = { bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39), cyan: wrap(36, 39), magenta: wrap(35, 39) };

export const ok = (message: string) => console.log(`${c.green("✓")} ${message}`);
export const warn = (message: string) => console.log(`${c.yellow("!")} ${message}`);
export const step = (message: string) => console.log(`${c.cyan("→")} ${message}`);

/** A heading and aligned rows, e.g. the addresses a server answers on. */
export function banner(title: string, rows: [label: string, value: string][]) {
  const width = Math.max(...rows.map(([l]) => l.length));
  console.log(`\n  ${title}\n`);
  for (const [label, value] of rows) console.log(`  ${c.dim("➜")}  ${c.bold(label.padEnd(width))}  ${value}`);
  console.log();
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Shows `message` with a spinner while `work` runs, then a ✓ or ✗ line. In a log (no terminal) it prints the message once.
 * `work` gets a function to change the message.
 */
export async function task<T>(message: string, work: (update: (message: string) => void) => Promise<T>): Promise<T> {
  const began = performance.now();
  let text = message;
  let frame = 0;
  const draw = () => process.stdout.write(`\r\x1b[2K${c.cyan(FRAMES[frame++ % FRAMES.length]!)} ${text}`);
  const timer = tty ? setInterval(draw, 80) : undefined;
  if (tty) draw();
  else console.log(`→ ${message}`);
  const took = () => c.dim(` ${((performance.now() - began) / 1000).toFixed(1)}s`);
  try {
    const result = await work((m) => (text = m));
    if (timer) clearInterval(timer);
    if (tty) process.stdout.write(`\r\x1b[2K`);
    console.log(`${c.green("✓")} ${text}${took()}`);
    return result;
  } catch (e) {
    if (timer) clearInterval(timer);
    if (tty) process.stdout.write(`\r\x1b[2K`);
    console.log(`${c.red("✗")} ${text}`);
    throw e;
  }
}
