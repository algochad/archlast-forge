// What a merge into master releases: whether it does at all, and which version. The release workflow (scripts/release-plan.ts) feeds it what changed
// since the last release; the rules are plain and listed here, so a surprise can be explained by reading them. Nothing here touches git or the network.
//
//   skip   nothing that ships changed (docs, workflows, tests), or the merge says [skip release]
//   patch  anything else that ships: a fix, an internal change, a dependency
//   minor  a change users can see: a new public export, a removed one, a new CLI flag, a new engine setting, a new scaffold file or package,
//          a `feat:` or breaking commit, or [minor] in a message. While the version is 0.x this is the "0.1.0" bump.
//
// The version is not written back to the repository: the workflow stamps it into the packages and the image and the tag records it. A person who
// wants a particular version (0.18.0, 1.0.0) sets it with scripts/version.ts in a pull request, and that version is released as it is.

export type Bump = "skip" | "patch" | "minor";

export interface FileChange {
  status: "A" | "M" | "D" | "R";
  path: string;
}
export interface Change {
  files: FileChange[];
  /** The full messages of the commits since the last release. */
  messages: string[];
  /** Per file, the lines the change added and removed (without the leading + or -): only the files `watchedForDiff` names are needed. */
  diffs: Record<string, { added: string[]; removed: string[] }>;
}
export interface Decision {
  bump: Bump;
  reasons: string[];
}

/** Test code, fixtures and docs about code don't ship in a package. */
const isTest = (path: string) =>
  /(^|\/)(test|tests|__tests__|test-types)\//.test(path) ||
  /\.(test|spec)\.[tj]sx?$/.test(path);
/** What reaches users: a package's code, templates and vendored files, its manifest, its notices, and the engine image's Dockerfile. */
export const ships = (path: string) =>
  !isTest(path) &&
  (/^packages\/[^/]+\/(src|template|vendor)\//.test(path) ||
    /^packages\/[^/]+\/(package\.json|THIRD_PARTY_NOTICES\.md|README\.md)$/.test(
      path,
    ) ||
    path === "docker/engine.Dockerfile");

/** The files that are a package's public face: what they export is what users import. */
export const isPublicSurface = (path: string) =>
  /^packages\/[^/]+\/src\/index\.ts$/.test(path) ||
  /^packages\/runtime\/src\/[a-z-]+\.ts$/.test(path) || // values, schema, functions, nest*, testing, telemetry, ...
  /^packages\/runtime\/src\/server\/index\.ts$/.test(path) ||
  /^packages\/framework\/src\/(client|server|build)\.ts$/.test(path);
const isCliSurface = (path: string) =>
  path === "packages/cli/src/index.ts" ||
  path === "packages/create-archlast-forge/src/options.ts";
const isSettings = (path: string) =>
  path === "packages/runtime/src/server/settings.ts";

/** The files whose added and removed lines `decideBump` reads. */
export const watchedForDiff = (path: string) =>
  isPublicSurface(path) || isCliSurface(path) || isSettings(path);

/** A commit's first line: where a conventional-commit type and a marker belong. */
const subjectOf = (message: string) => message.split("\n")[0]!.trim();
/**
 * The markers a commit asks for: [skip release], [release] and [minor], at the end of its first line ("Fix a thing [skip release]") or on a line
 * of their own. Not mid-sentence and not in `code`: a message that explains the markers must not act on them.
 */
export function markersOf(
  messages: string[],
): Set<"skip release" | "release" | "minor"> {
  const found = new Set<"skip release" | "release" | "minor">();
  for (const message of messages) {
    const lines = message.split("\n").map((l) => l.trim());
    for (const [i, line] of lines.entries()) {
      const m = /^(?:.*\s)?\[(skip release|release|minor)\]$/i.exec(line);
      if (m && (i === 0 || line.startsWith("[")))
        found.add(m[1]!.toLowerCase() as "skip release" | "release" | "minor");
    }
  }
  return found;
}
const FEAT = /^feat(\([^)]*\))?!?:/;
const BREAKING_SUBJECT = /^[a-z]+(\([^)]*\))?!:/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/m;

export function decideBump(change: Change): Decision {
  const marks = markersOf(change.messages);
  const subjects = change.messages.map(subjectOf);
  const reasons: string[] = [];

  if (marks.has("skip release") && !marks.has("release"))
    return { bump: "skip", reasons: ["a commit says [skip release]"] };

  const shipped = change.files.filter((f) => ships(f.path));
  const forced = marks.has("release");
  if (!shipped.length && !forced)
    return {
      bump: "skip",
      reasons: [
        "nothing a package or the image ships changed (docs, workflows, scripts and tests don't)",
      ],
    };
  if (!shipped.length) reasons.push("[release] forces a release");

  const minor: string[] = [];
  if (marks.has("minor")) minor.push("a commit says [minor]");
  if (subjects.some((l) => FEAT.test(l))) minor.push("a feat: commit");
  if (
    subjects.some((l) => BREAKING_SUBJECT.test(l)) ||
    change.messages.some((m) => BREAKING_FOOTER.test(m))
  )
    minor.push("a breaking change is marked");

  for (const f of change.files) {
    if (f.status === "A" && /^packages\/[^/]+\/package\.json$/.test(f.path))
      minor.push(`a new package (${f.path.split("/")[1]})`);
    if (
      f.status === "A" &&
      /^packages\/create-archlast-forge\/template\//.test(f.path)
    )
      minor.push(
        `a new file the scaffolder writes (${f.path.replace("packages/create-archlast-forge/template/", "")})`,
      );
  }
  for (const [path, d] of Object.entries(change.diffs)) {
    if (isPublicSurface(path)) {
      const added = d.added.filter((l) => /^export\s/.test(l.trim()));
      const removed = d.removed.filter((l) => /^export\s/.test(l.trim()));
      if (added.length)
        minor.push(
          `${path} exports something new: ${added[0]!.trim().slice(0, 60)}`,
        );
      if (removed.length)
        minor.push(
          `${path} no longer exports: ${removed[0]!.trim().slice(0, 60)}`,
        );
    }
    if (
      isCliSurface(path) &&
      d.added.some(
        (l) => /(^|\s)--[a-z][a-z-]+/.test(l) && !/^\s*(\/\/|\*)/.test(l),
      )
    )
      minor.push(`${path} has a new flag or command`);
    if (
      isSettings(path) &&
      d.added.some((l) => /\bname:\s*"[A-Z][A-Z0-9_]+"/.test(l))
    )
      minor.push("a new engine setting");
  }
  if (minor.length) return { bump: "minor", reasons: [...reasons, ...minor] };
  return {
    bump: "patch",
    reasons: [
      ...reasons,
      shipped.length
        ? `${shipped.length} shipped file(s) changed and nothing that adds to the public surface`
        : "forced",
    ],
  };
}

type Semver = [number, number, number];
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;
export const parse = (v: string): Semver | undefined => {
  const m = SEMVER.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
};
/** Negative when a < b. A pre-release (1.2.3-rc.1) comes before its release (1.2.3). */
export function compare(a: string, b: string): number {
  const [x, y] = [parse(a), parse(b)];
  if (!x || !y) throw new Error(`not versions: ${a}, ${b}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  const [pa, pb] = [a.includes("-"), b.includes("-")];
  return pa === pb ? 0 : pa ? -1 : 1;
}

/**
 * The version a release gets. `base` is what the packages' package.json say, `latest` the highest version released so far (the highest v* tag).
 *  - base above latest: a person set it (scripts/version.ts) and that exact version goes out, whatever the change.
 *  - otherwise the next one after latest: the patch, or for a minor bump the next minor (0.17.3 becomes 0.18.0).
 */
export function nextVersion(
  base: string,
  latest: string | undefined,
  bump: Exclude<Bump, "skip">,
): { version: string; chosen: boolean } {
  if (!latest || compare(base, latest) > 0)
    return { version: base, chosen: true };
  const [major, minor, patch] = parse(latest)!;
  return {
    version:
      bump === "minor"
        ? `${major}.${minor + 1}.0`
        : `${major}.${minor}.${patch + 1}`,
    chosen: false,
  };
}

/** The highest released version among tag names: v1.2.3 counts, v1.2.3-rc.1 and other tags don't. */
export function latestRelease(tags: string[]): string | undefined {
  const releases = tags
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
    .map((t) => t.slice(1));
  return releases.sort(compare).at(-1);
}

/** `git diff --name-status` output, as FileChange[] (a rename counts as its new path being added and the old one deleted). */
export function parseNameStatus(text: string): FileChange[] {
  const files: FileChange[] = [];
  for (const line of text.split("\n").filter(Boolean)) {
    const [status, a, b] = line.split("\t");
    if (!status || !a) continue;
    if (status.startsWith("R") && b)
      files.push({ status: "D", path: a }, { status: "A", path: b });
    else files.push({ status: status[0] as FileChange["status"], path: a });
  }
  return files;
}

/** `git diff -U0` output, as the lines added and removed per file. */
export function parseDiff(text: string): Change["diffs"] {
  const out: Change["diffs"] = {};
  let file: { added: string[]; removed: string[] } | undefined;
  for (const line of text.split("\n")) {
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) {
      file = out[header[1]!] = { added: [], removed: [] };
    } else if (line.startsWith("+") && !line.startsWith("+++"))
      file?.added.push(line.slice(1));
    else if (line.startsWith("-") && !line.startsWith("---"))
      file?.removed.push(line.slice(1));
  }
  return out;
}
