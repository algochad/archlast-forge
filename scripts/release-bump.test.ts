import { describe, expect, test } from "bun:test";
import {
  compare,
  decideBump,
  latestRelease,
  markersOf,
  nextVersion,
  parseDiff,
  parseNameStatus,
  ships,
  type Change,
} from "./release-bump";

const change = (over: Partial<Change> & { paths?: string[] } = {}): Change => ({
  files: (over.paths ?? ["packages/runtime/src/server/executor.ts"]).map(
    (path) => ({ status: "M" as const, path }),
  ),
  messages: over.messages ?? ["Fix a thing"],
  diffs: over.diffs ?? {},
});

describe("what ships", () => {
  test("packages' code, templates, vendored files, manifests and the engine Dockerfile do; tests, docs, workflows and scripts don't", () => {
    for (const p of [
      "packages/runtime/src/server/cache.ts",
      "packages/create-archlast-forge/template/base/forge/schema.ts",
      "packages/dashboard/vendor/scalar/standalone.js.br",
      "packages/cli/package.json",
      "docker/engine.Dockerfile",
    ])
      expect(ships(p)).toBe(true);
    for (const p of [
      "packages/runtime/test/redis-prefix.test.ts",
      "packages/runtime/src/server/cache.test.ts",
      "apps/docs/content/nest.mdx",
      ".github/workflows/ci.yml",
      "scripts/pack.ts",
      "docs/decisions.md",
      "skills/archlast-forge/SKILL.md",
      "README.md",
      "bun.lock",
    ])
      expect(ships(p)).toBe(false);
  });
});

describe("whether a merge releases", () => {
  test("a merge that changes only docs, workflows, scripts or tests is skipped", () => {
    const d = decideBump(
      change({
        paths: [
          "apps/docs/content/nest.mdx",
          ".github/workflows/ci.yml",
          "scripts/release-plan.ts",
          "packages/runtime/test/x.test.ts",
          "skills/archlast-forge/SKILL.md",
        ],
      }),
    );
    expect(d.bump).toBe("skip");
  });
  test("[skip release] skips even a change that ships", () => {
    expect(
      decideBump(change({ messages: ["Fix a thing [skip release]"] })).bump,
    ).toBe("skip");
  });
  test("[release] releases even a merge that ships nothing", () => {
    expect(
      decideBump(
        change({
          paths: ["apps/docs/content/nest.mdx"],
          messages: ["Docs [release]"],
        }),
      ).bump,
    ).toBe("patch");
  });
  test("both markers together release: [release] is the deliberate one", () => {
    expect(
      decideBump(change({ messages: ["a [skip release]", "b [release]"] }))
        .bump,
    ).toBe("patch");
  });
});

describe("markers and commit types count where they are meant, not where a message talks about them", () => {
  const prose = [
    "Releases pick their own version\n\nnone: nothing ships, or [skip release];\nminor: a new export, a feat: commit, or [minor]; [release] forces a release.\n\nThe `[minor]` marker and `[skip release]` are described here.",
  ];
  test("a message that explains the markers neither forces, skips nor bumps", () => {
    expect(decideBump(change({ messages: prose })).bump).toBe("patch");
    expect(
      decideBump(
        change({ paths: ["apps/docs/content/nest.mdx"], messages: prose }),
      ).bump,
    ).toBe("skip");
  });
  test("a marker at the end of the first line, or on a line of its own, counts", () => {
    expect(markersOf(["Fix a thing [skip release]"]).has("skip release")).toBe(
      true,
    );
    expect(markersOf(["Fix a thing\n\nBody.\n[minor]\n"]).has("minor")).toBe(
      true,
    );
    expect(markersOf(["Docs [release]"]).has("release")).toBe(true);
  });
  test("a marker in the middle of a sentence, in the body, or in code does not", () => {
    expect(
      markersOf(["Fix\n\nthis is [minor] in the middle of a line"]).size,
    ).toBe(0);
    expect(markersOf(["Fix\n\nends with a marker [minor]"]).size).toBe(0); // the end of a body line, not the first line
    expect(markersOf(["Fix `[skip release]`"]).size).toBe(0);
  });
  test("feat: counts only as a commit type at the start of a first line", () => {
    expect(
      decideBump(
        change({ messages: ["Fix\n\nfeat: this line is in the body"] }),
      ).bump,
    ).toBe("patch");
    expect(
      decideBump(change({ messages: ["Update things\n\n- a feat: in a list"] }))
        .bump,
    ).toBe("patch");
    expect(decideBump(change({ messages: ["feat: a real one"] })).bump).toBe(
      "minor",
    );
  });
});

describe("how big a bump", () => {
  test("an ordinary change that ships is a patch", () => {
    const d = decideBump(
      change({
        paths: [
          "packages/runtime/src/server/cache.ts",
          "packages/runtime/test/cache.test.ts",
        ],
      }),
    );
    expect(d.bump).toBe("patch");
  });
  test("a new public export is a minor, and so is a removed one", () => {
    const base = ["packages/runtime/src/nest.ts"];
    expect(
      decideBump(
        change({
          paths: base,
          diffs: {
            "packages/runtime/src/nest.ts": {
              added: ["export function claim() {}"],
              removed: [],
            },
          },
        }),
      ).bump,
    ).toBe("minor");
    expect(
      decideBump(
        change({
          paths: base,
          diffs: {
            "packages/runtime/src/nest.ts": {
              added: [],
              removed: ["export const gone = 1;"],
            },
          },
        }),
      ).bump,
    ).toBe("minor");
  });
  test("an export in an internal file is not a public change", () => {
    const d = decideBump(
      change({
        paths: ["packages/runtime/src/server/cache.ts"],
        diffs: {
          "packages/runtime/src/server/cache.ts": {
            added: ["export class Thing {}"],
            removed: [],
          },
        },
      }),
    );
    expect(d.bump).toBe("patch");
  });
  test("a changed line that isn't an export is a patch", () => {
    const d = decideBump(
      change({
        paths: ["packages/react/src/index.ts"],
        diffs: {
          "packages/react/src/index.ts": {
            added: ["  const x = 2;"],
            removed: ["  const x = 1;"],
          },
        },
      }),
    );
    expect(d.bump).toBe("patch");
  });
  test("a new engine setting is a minor (REDIS_PREFIX was one)", () => {
    const d = decideBump(
      change({
        paths: ["packages/runtime/src/server/settings.ts"],
        diffs: {
          "packages/runtime/src/server/settings.ts": {
            added: ['    name: "REDIS_PREFIX",'],
            removed: [],
          },
        },
      }),
    );
    expect(d.bump).toBe("minor");
    expect(d.reasons.join()).toContain("setting");
  });
  test("editing the text of a setting is not", () => {
    const d = decideBump(
      change({
        paths: ["packages/runtime/src/server/settings.ts"],
        diffs: {
          "packages/runtime/src/server/settings.ts": {
            added: ['    doc: "New words.",'],
            removed: ['    doc: "Old words.",'],
          },
        },
      }),
    );
    expect(d.bump).toBe("patch");
  });
  test("a new CLI flag is a minor; a comment mentioning one is not", () => {
    const f = "packages/cli/src/index.ts";
    expect(
      decideBump(
        change({
          paths: [f],
          diffs: {
            [f]: { added: ["  --dry-run  show the plan"], removed: [] },
          },
        }),
      ).bump,
    ).toBe("minor");
    expect(
      decideBump(
        change({
          paths: [f],
          diffs: {
            [f]: {
              added: ["  // remember --dry-run is for show"],
              removed: [],
            },
          },
        }),
      ).bump,
    ).toBe("patch");
  });
  test("a new package, or a new file the scaffolder writes, is a minor", () => {
    expect(
      decideBump({
        files: [{ status: "A", path: "packages/angular/package.json" }],
        messages: ["x"],
        diffs: {},
      }).bump,
    ).toBe("minor");
    expect(
      decideBump({
        files: [
          {
            status: "A",
            path: "packages/create-archlast-forge/template/base/forge/new.ts",
          },
        ],
        messages: ["x"],
        diffs: {},
      }).bump,
    ).toBe("minor");
  });
  test("a feat: commit, a breaking marker or [minor] is a minor", () => {
    expect(decideBump(change({ messages: ["feat: add a thing"] })).bump).toBe(
      "minor",
    );
    expect(
      decideBump(change({ messages: ["feat(cli): add a thing"] })).bump,
    ).toBe("minor");
    expect(
      decideBump(change({ messages: ["refactor!: drop the old call"] })).bump,
    ).toBe("minor");
    expect(
      decideBump(change({ messages: ["Change\n\nBREAKING CHANGE: it moved"] }))
        .bump,
    ).toBe("minor");
    expect(
      decideBump(change({ messages: ["Small change [minor]"] })).bump,
    ).toBe("minor");
  });
  test("the word feat inside a sentence is not a feat: commit", () => {
    expect(
      decideBump(change({ messages: ["Fix the feat: parser"] })).bump,
    ).toBe("patch");
  });
});

describe("which version", () => {
  test("the next patch after the last release", () => {
    expect(nextVersion("0.17.0", "0.17.0", "patch")).toEqual({
      version: "0.17.1",
      chosen: false,
    });
    expect(nextVersion("0.17.0", "0.17.4", "patch")).toEqual({
      version: "0.17.5",
      chosen: false,
    });
  });
  test("the next minor, with the patch back at 0", () => {
    expect(nextVersion("0.17.0", "0.17.4", "minor")).toEqual({
      version: "0.18.0",
      chosen: false,
    });
  });
  test("a version a person set above the last release goes out as it is, whatever the change", () => {
    expect(nextVersion("0.18.0", "0.17.4", "patch")).toEqual({
      version: "0.18.0",
      chosen: true,
    });
    expect(nextVersion("1.0.0", "0.17.4", "minor")).toEqual({
      version: "1.0.0",
      chosen: true,
    });
  });
  test("the first release has no last release: the version in the packages", () => {
    expect(nextVersion("0.1.0", undefined, "patch")).toEqual({
      version: "0.1.0",
      chosen: true,
    });
  });
  test("versions compare numerically, and a pre-release comes before its release", () => {
    expect(compare("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compare("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compare("1.0.0", "1.0.0")).toBe(0);
  });
  test("the last release is the highest release tag: pre-releases and other tags don't count", () => {
    expect(
      latestRelease(["v0.9.0", "v0.10.0", "v0.10.1-rc.1", "nightly", "v0.2.0"]),
    ).toBe("0.10.0");
    expect(latestRelease(["nightly"])).toBeUndefined();
  });
});

describe("reading git's output", () => {
  test("name-status: added, modified, deleted, and a rename as a delete plus an add", () => {
    expect(
      parseNameStatus("A\ta.ts\nM\tb.ts\nD\tc.ts\nR100\told.ts\tnew.ts\n"),
    ).toEqual([
      { status: "A", path: "a.ts" },
      { status: "M", path: "b.ts" },
      { status: "D", path: "c.ts" },
      { status: "D", path: "old.ts" },
      { status: "A", path: "new.ts" },
    ]);
  });
  test("a -U0 diff gives the added and removed lines per file", () => {
    const text = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1 +1,2 @@",
      "-old",
      "+new",
      "+export const y = 1;",
      "diff --git a/z.ts b/z.ts",
      "--- a/z.ts",
      "+++ b/z.ts",
      "@@ -3 +3 @@",
      "-gone",
    ].join("\n");
    expect(parseDiff(text)).toEqual({
      "x.ts": { added: ["new", "export const y = 1;"], removed: ["old"] },
      "z.ts": { added: [], removed: ["gone"] },
    });
  });
});
