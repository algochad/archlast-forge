import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";

/** A Chromium to drive, or undefined: set CHROMIUM_PATH, or install one with `bunx playwright-core install chromium`. */
export function chromiumPath(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cache = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(cache)) return undefined;
  for (const dir of readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort().reverse()) {
    for (const exe of [join(cache, dir, "chrome-linux64", "chrome"), join(cache, dir, "chrome-linux", "chrome")]) if (existsSync(exe)) return exe;
  }
  return undefined;
}

/** Launches Chromium, or returns undefined when this machine can't (missing libraries, no browser): browser tests then skip. */
export async function launchBrowser(): Promise<Browser | undefined> {
  const executablePath = chromiumPath();
  if (!executablePath) return undefined;
  try {
    const { chromium } = await import("playwright-core");
    return await chromium.launch({ executablePath, args: ["--no-sandbox"] });
  } catch (e) {
    console.warn(`browser tests skipped: ${(e as Error).message.split("\n")[0]}`);
    return undefined;
  }
}
