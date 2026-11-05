import { describe, expect, test } from "bun:test";
import { sectionBody, stampNotes, stampVersionStrings } from "./release-notes";

const page = (unreleased: string) => `# Release notes

Intro.

## Unreleased
${unreleased}
## 0.17.0

Old notes.
`;

describe("stampNotes", () => {
  test("moves Unreleased under the version and opens an empty Unreleased above it", () => {
    const out = stampNotes(page("\n### Changed\n\n- A thing.\n  - its detail\n"), "0.18.0");
    expect(out).toBe(`# Release notes

Intro.

## Unreleased

## 0.18.0

### Changed

- A thing.
  - its detail

## 0.17.0

Old notes.
`);
    expect(sectionBody(out, "## Unreleased")).toEqual([]);
  });

  test("leaves a page that has the version already, and is idempotent", () => {
    const once = stampNotes(page("\n- A thing.\n"), "0.18.0");
    expect(stampNotes(once, "0.18.0")).toBe(once);
    const written = page("\n- Later.\n").replace("## 0.17.0", "## 0.18.0\n\nBy hand.\n\n## 0.17.0");
    expect(stampNotes(written, "0.18.0")).toBe(written);
  });

  test("on staging, only what was released moves: notes that landed after the release stay under Unreleased", () => {
    const released = page("\n### Changed\n\n- Shipped one.\n- Shipped two.\n");
    const staging = page("\n### Changed\n\n- Landed later.\n- Shipped one.\n- Shipped two.\n\n### Documentation\n\n- A new page.\n");
    const out = stampNotes(staging, "0.18.0", { released });
    expect(sectionBody(out, "## Unreleased")).toEqual(["### Changed", "", "- Landed later.", "", "### Documentation", "", "- A new page."]);
    expect(sectionBody(out, "## 0.18.0")).toEqual(["### Changed", "", "- Shipped one.", "- Shipped two."]);
    expect(out.indexOf("## Unreleased")).toBeLessThan(out.indexOf("## 0.18.0"));
  });

  test("a subheading whose notes all shipped leaves Unreleased", () => {
    const released = page("\n### Changed\n\n- Shipped.\n");
    const out = stampNotes(page("\n### Changed\n\n- Shipped.\n"), "0.18.0", { released });
    expect(sectionBody(out, "## Unreleased")).toEqual([]);
  });

  test("a release with nothing noted says so, with the comparison", () => {
    const out = stampNotes(page("\n"), "0.17.1", { compare: "https://example.test/compare" });
    expect(sectionBody(out, "## 0.17.1")).toEqual(["Fixes and internal changes, with nothing to note here: [what changed](https://example.test/compare)."]);
  });

  test("a page with no Unreleased gets both sections before the first version", () => {
    const out = stampNotes("# Release notes\n\n## 0.17.0\n\nOld.\n", "0.17.1");
    expect(out.indexOf("## Unreleased")).toBeLessThan(out.indexOf("## 0.17.1"));
    expect(out.indexOf("## 0.17.1")).toBeLessThan(out.indexOf("## 0.17.0"));
  });
});

describe("stampVersionStrings", () => {
  test("moves the samples' version strings and nothing else", () => {
    const text = [
      "  archlast-forge 0.17.0  ·  full-stack app  · ready in 738 ms",
      "ARG ENGINE_IMAGE=ghcr.io/algochad/archlast-forge-engine:0.17.0",
      "| `Engine image ghcr.io/…:0.17.0 isn't available.` |",
      `  "dependencies": { "@archlast/forge-runtime": "^0.17.0", "stripe": "^17.0.0" }`,
      "Signatures are copied from the source of version 0.17.0.",
      "Redis keys moved in 0.17.0, and 0.17.0-rc.1 was a pre-release.",
    ].join("\n");
    expect(stampVersionStrings(text, "0.17.0", "0.18.0")).toBe(
      [
        "  archlast-forge 0.18.0  ·  full-stack app  · ready in 738 ms",
        "ARG ENGINE_IMAGE=ghcr.io/algochad/archlast-forge-engine:0.18.0",
        "| `Engine image ghcr.io/…:0.18.0 isn't available.` |",
        `  "dependencies": { "@archlast/forge-runtime": "^0.18.0", "stripe": "^17.0.0" }`,
        "Signatures are copied from the source of version 0.18.0.",
        "Redis keys moved in 0.17.0, and 0.17.0-rc.1 was a pre-release.",
      ].join("\n"),
    );
  });
});
