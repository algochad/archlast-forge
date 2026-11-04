import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffold, scaffoldMonorepo } from "create-archlast-forge";
import { upgradeFiles, upgradeWorkspaceFiles } from "../src/upgrade";

const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");

test("upgrade moves every archlast-forge package and the engine image, and leaves the rest of each file as it was", () => {
  for (const mode of ["backend", "framework"] as const) {
    const dir = join(mkdtempSync(join(tmpdir(), "afx-upgrade-")), mode);
    scaffold({ dir, mode, services: ["postgres"], version: "0.8.0" });
    const pkg = JSON.parse(read(dir, "package.json"));
    pkg.devDependencies["@archlast/forge-client"] = "workspace:*"; // not a version: left alone
    pkg.devDependencies["@archlast/forge-dashboard"] = "~0.8.0";
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 4) + "\n");
    const before = (f: string) => read(dir, f).replaceAll("0.8.0", "0.9.0");
    const expected = Object.fromEntries(["package.json", "forge/package.json", "Dockerfile", "compose.yaml"].map((f) => [f, before(f)]));

    const changes = upgradeFiles(join(dir, "forge"), "0.9.0");
    for (const [f, text] of Object.entries(expected)) expect(read(dir, f), f).toBe(text);
    expect(changes).toContainEqual({ file: "forge/package.json", name: "@archlast/forge-runtime", from: "^0.8.0", to: "^0.9.0" });
    expect(changes).toContainEqual({ file: "package.json", name: "@archlast/forge-dashboard", from: "~0.8.0", to: "~0.9.0" });
    expect(changes).toContainEqual({ file: "compose.yaml", name: "engine image", from: "0.8.0", to: "0.9.0" });
    expect(changes.filter((c) => c.file === "Dockerfile")).toHaveLength(1);
    if (mode === "framework") expect(changes).toContainEqual({ file: "package.json", name: "@archlast/forge-framework", from: "^0.8.0", to: "^0.9.0" });
    expect(JSON.parse(read(dir, "package.json")).devDependencies["@archlast/forge-client"]).toBe("workspace:*");

    expect(upgradeFiles(join(dir, "forge"), "0.9.0")).toEqual([]); // already there
  }
}, 30_000); // each scaffold runs Prettier

test("upgrade moves a monorepo whole: every app, service and package, and nothing that isn't a version", () => {
  const root = join(mkdtempSync(join(tmpdir(), "afx-upgrade-ws-")), "fleet");
  scaffoldMonorepo({ dir: root, mode: "backend", services: [], microservices: ["orders"], mobile: true, desktop: "client", version: "0.8.0" });
  const names = (c: { file: string }[]) => [...new Set(c.map((x) => x.file))].sort();
  const changes = upgradeWorkspaceFiles(root, "0.9.0");
  expect(names(changes)).toEqual([
    "apps/api/Dockerfile",
    "apps/api/compose.yaml",
    "apps/api/forge/package.json",
    "apps/api/package.json",
    "apps/desktop/package.json",
    "apps/mobile/package.json",
    "apps/orders/Dockerfile",
    "apps/orders/compose.yaml",
    "apps/orders/forge/package.json",
    "apps/orders/package.json",
    "packages/api/package.json",
    "packages/contracts/package.json",
  ]);
  // The phone app and the typed-API packages are not projects, and still move.
  expect(changes).toContainEqual({ file: "apps/mobile/package.json", name: "@archlast/forge-react", from: "^0.8.0", to: "^0.9.0" });
  expect(changes).toContainEqual({ file: "packages/api/package.json", name: "@archlast/forge-runtime", from: "^0.8.0", to: "^0.9.0" });
  expect(changes).toContainEqual({ file: "apps/orders/compose.yaml", name: "engine image", from: "0.8.0", to: "0.9.0" });
  // Workspace links and other packages are left as they were.
  expect(JSON.parse(read(root, "packages/api/package.json")).devDependencies["@fleet/backend"]).toBe("workspace:*");
  expect(JSON.parse(read(root, "apps/mobile/package.json")).dependencies.expo).toMatch(/^~58/);
  expect(upgradeWorkspaceFiles(root, "0.9.0")).toEqual([]); // already there
}, 60_000);

test("upgrade gives an older full-stack app's root type-check Bun's types, which the forge/ files its pages reach need", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "afx-upgrade-types-")), "app");
  scaffold({ dir, mode: "framework", services: [], version: "0.8.0" });
  expect(JSON.parse(read(dir, "tsconfig.json")).compilerOptions.types).toEqual(["bun"]); // new apps have them
  // As older scaffolds wrote them: no types at the root, no @types/bun.
  writeFileSync(join(dir, "tsconfig.json"), read(dir, "tsconfig.json").replace(/"types": \[\s*"bun"\s*\]/, '"types": []'));
  const pkg = JSON.parse(read(dir, "package.json"));
  delete pkg.devDependencies["@types/bun"];
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 4) + "\n");

  const changes = upgradeFiles(join(dir, "forge"), "0.8.0");
  expect(changes).toEqual([
    { file: "tsconfig.json", name: "compilerOptions.types", from: "[]", to: '["bun"]' },
    { file: "package.json", name: "@types/bun", from: "none", to: "1.4.4" },
  ]);
  expect(JSON.parse(read(dir, "tsconfig.json")).compilerOptions.types).toEqual(["bun"]);
  expect(JSON.parse(read(dir, "package.json")).devDependencies["@types/bun"]).toBe("1.4.4");
  expect(read(dir, "package.json")).toContain('\n    "devDependencies"'); // its four-space indent kept
  expect(upgradeFiles(join(dir, "forge"), "0.8.0")).toEqual([]);
}, 30_000);
