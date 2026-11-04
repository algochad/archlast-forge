// The release notes page (apps/docs/content/release-notes.mdx) and the version strings in the docs' samples, as the release workflow updates
// them after a release: what was under "## Unreleased" moves under "## X.Y.Z", a new empty "## Unreleased" goes above it, and the samples that
// show a version (the CLI's banner, the engine image tag, a dependency range, the reference's header) say the new one. Pure functions, so
// scripts/release-notes.test.ts covers them; scripts/release-stamp.ts applies them to the files and release-notes-section.ts reads them.

export const UNRELEASED = "## Unreleased";

interface Section {
  heading: string;
  /** The heading's line. */
  start: number;
  /** The line after the section's last one. */
  end: number;
}

/** The "## " sections of the page, in order. */
function sections(lines: string[]): Section[] {
  const starts = lines.flatMap((l, i) => (l.startsWith("## ") ? [i] : []));
  return starts.map((start, n) => ({ heading: lines[start]!.trim(), start, end: starts[n + 1] ?? lines.length }));
}

const trimBlank = (lines: string[]) => {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a]!.trim()) a++;
  while (b > a && !lines[b - 1]!.trim()) b--;
  return lines.slice(a, b);
};

/** The lines of a section, without its heading and the blank lines around them. */
export function sectionBody(text: string, heading: string): string[] | undefined {
  const lines = text.split("\n");
  const s = sections(lines).find((x) => x.heading === heading);
  return s && trimBlank(lines.slice(s.start + 1, s.end));
}

/** Drops "### " subheadings that are left with nothing under them, and runs of blank lines. */
function tidy(lines: string[]): string[] {
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (line.startsWith("### ")) {
      const next = lines.slice(i + 1).find((l) => l.trim());
      if (!next || next.startsWith("### ")) return;
    }
    if (!line.trim() && !out.at(-1)?.trim()) return;
    out.push(line);
  });
  return trimBlank(out);
}

export interface StampOptions {
  /**
   * The page as it was in the released commit. Its "Unreleased" lines are what the release contains; the page being stamped may have more
   * under "Unreleased" (staging, where changes keep landing), which stay there. Without it, everything under "Unreleased" was released.
   */
  released?: string;
  /** A link to what changed, for a release whose "Unreleased" was empty. */
  compare?: string;
}

/**
 * Moves the release's notes from "## Unreleased" to "## <version>" and opens a new "## Unreleased" above it. A page that already has
 * "## <version>" (a person wrote it, or this ran before) is returned as it is.
 */
export function stampNotes(text: string, version: string, options: StampOptions = {}): string {
  const lines = text.split("\n");
  const all = sections(lines);
  if (all.some((s) => s.heading === `## ${version}`)) return text;
  const at = all.find((s) => s.heading === UNRELEASED);
  const body = at ? trimBlank(lines.slice(at.start + 1, at.end)) : [];
  const released = options.released === undefined ? body : (sectionBody(options.released, UNRELEASED) ?? []);
  // Lines that were released leave "Unreleased"; subheadings stay for whatever is still under them.
  const shipped = new Set(released.filter((l) => l.trim() && !l.startsWith("### ")));
  const remaining = options.released === undefined ? [] : tidy(body.filter((l) => !shipped.has(l)));
  const notes = released.some((l) => l.trim())
    ? released
    : [`Fixes and internal changes, with nothing to note here${options.compare ? `: [what changed](${options.compare})` : ""}.`];
  const block = [UNRELEASED, "", ...(remaining.length ? [...remaining, ""] : []), `## ${version}`, "", ...notes, ""];
  // Without an "Unreleased" section, the new ones go before the first version.
  const start = at?.start ?? all[0]?.start ?? lines.length;
  const end = at?.end ?? start;
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n");
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The version strings of the docs' samples, from `from` to `to`: the CLI's banner (`archlast-forge X.Y.Z  ·`), the engine image's tag
 * (`ghcr.io/…:X.Y.Z`), a range on one of the packages (`"@archlast/forge-runtime": "^X.Y.Z"`) and the reference's "the source of version
 * X.Y.Z". Other mentions of a version ("added in 0.17.0") are history and stay.
 */
export function stampVersionStrings(text: string, from: string, to: string): string {
  const v = escape(from);
  return text
    .replace(new RegExp(`(archlast-forge )${v}(  ·)`, "g"), `$1${to}$2`)
    .replace(new RegExp(`(ghcr\\.io/\\S*?:)${v}(?![\\w-]|\\.\\d)`, "g"), `$1${to}`)
    .replace(new RegExp(`("@archlast/forge-[\\w-]+"\\s*:\\s*"[~^]?)${v}"`, "g"), `$1${to}"`)
    .replace(new RegExp(`(the source of version )${v}(?![\\w-]|\\.\\d)`, "g"), `$1${to}`);
}
