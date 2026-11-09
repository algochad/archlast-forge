// What each component of an app would ship to the browser: nothing (a "page"), a chunk of its own that hydrates alone (an "island"), or
// whatever it ships today (a "fallback"). This reads the code the way a reader would, by what it does: hooks that hold state or react to
// the browser, event handlers, refs, browser globals. It never guesses: when it cannot tell, the answer is the heavier one.
//
// It reads what Bun's transpiler makes of the file (plain JavaScript, JSX as `jsx(...)` calls), parsed with acorn, so it works wherever
// the framework builds, TypeScript or not. See packages/tuyere/docs/fullstack.md.
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import * as acorn from "acorn";
import { scanRoutes, type RouteFile } from "./routes";

export type Tier = "page" | "island" | "fallback";

export interface ComponentReport {
  name: string;
  file: string;
  /** What the component does by itself. */
  own: Tier;
  /** What it comes to once the components it renders are taken into account. */
  tier: Tier;
  /** Why it is not a page, in words. */
  reasons: string[];
  /** Islands it renders (they hydrate on their own roots inside this page). */
  islands: string[];
  /** How its file exports it ("default" or a name), when it does: what an island is loaded by. */
  exportName?: string;
  /** It renders an `<Outlet />`, itself or through a component it renders. */
  usesOutlet?: boolean;
  /** Set when it cannot be hydrated on its own because it has no module to load (so whoever renders it is an island too). */
  unmountable?: true;
}

export interface RouteReport {
  id: string;
  file: string;
  tier: Tier;
  component?: string;
  /** Exports other than the component that matter to the render model (`action`, `ErrorBoundary`, ...). */
  notes: string[];
}

export interface AppReport {
  /** The islands the build mounts: those a page renders, and routes that are islands themselves. */
  mounts: ComponentReport[];
  root?: RouteReport;
  routes: RouteReport[];
  components: ComponentReport[];
}

/** Hooks that read what the server already knows. They hold no state and do not change in the browser, so they keep a component a page. */
const PURE_HOOKS = new Set([
  "useViewer",
  "useTimeZone",
  "useLoaderData",
  "useParams",
  "useRouteLoaderData",
  "useNonce",
  "useMatches",
  "useContext",
  "useMemo",
  "useCallback",
  "useId",
  "use",
  "useDebugValue",
]);
const GLOBALS = new Set([
  "window",
  "document",
  "localStorage",
  "sessionStorage",
  "navigator",
  "matchMedia",
  "IntersectionObserver",
  "ResizeObserver",
  "MutationObserver",
  "requestAnimationFrame",
  "requestIdleCallback",
  "addEventListener",
  "removeEventListener",
  "BroadcastChannel",
  "WebSocket",
  "EventSource",
]);
/** Components from the framework and React Router that are a page when they are alone. */
const PAGE_COMPONENTS = new Set([
  "Link",
  "NavLink",
  "Outlet",
  "Fragment",
  "Suspense",
]);
/**
 * Components of packages that render the same HTML with or without hydration when they are given no handlers: icons, and the plain button and input
 * primitives the shadcn/ui starter is made of. Anything else from a package is not read, and a component that renders it is an island.
 */
const PURE_PACKAGE_COMPONENTS: [RegExp, RegExp][] = [
  [/^lucide-react$/, /.*/],
  [/^@base-ui\/react\/(button|input)$/, /^(Button|Input)$/],
];
const INTERACTIVE_COMPONENTS = new Set(["Form", "ScrollRestoration", "Await"]);

export type Node = acorn.Node & Record<string, any>;

const transpilers = new Map<string, Bun.Transpiler>();
export function toJs(file: string, source: string): string {
  const loader = file.endsWith(".tsx")
    ? "tsx"
    : file.endsWith(".ts")
      ? "ts"
      : file.endsWith(".jsx")
        ? "jsx"
        : "js";
  let t = transpilers.get(loader);
  if (!t) transpilers.set(loader, (t = new Bun.Transpiler({ loader })));
  return t.transformSync(source);
}

/** Every node under `node`, depth first. */
function* walk(node: any): Generator<Node> {
  if (!node || typeof node.type !== "string") return;
  yield node;
  for (const key in node) {
    if (key === "type" || key === "start" || key === "end") continue;
    const v = node[key];
    if (Array.isArray(v)) for (const c of v) yield* walk(c);
    else if (v && typeof v === "object") yield* walk(v);
  }
}

export const isJsxCall = (n: Node) =>
  n.type === "CallExpression" &&
  n.callee.type === "Identifier" &&
  /^jsx(s|DEV)?(_\w+)?$/.test(n.callee.name);
export const nameOfCallee = (c: Node): string | undefined =>
  c.type === "Identifier"
    ? c.name
    : c.type === "MemberExpression" &&
        !c.computed &&
        c.property.type === "Identifier"
      ? c.property.name
      : undefined;
export const keyName = (p: Node): string | undefined =>
  p.type === "Property"
    ? p.key.type === "Identifier"
      ? p.key.name
      : p.key.type === "Literal"
        ? String(p.key.value)
        : undefined
    : undefined;

export interface Fn {
  name: string;
  node: Node;
  exported: boolean;
}

/** `function`, `() => …`, or either one inside `forwardRef(...)` / `memo(...)`. */
function wrapped(init: Node): Node | undefined {
  if (/^(Arrow)?FunctionExpression$/.test(init.type)) return init;
  if (
    init.type === "CallExpression" &&
    ["forwardRef", "memo"].includes(nameOfCallee(init.callee) ?? "") &&
    init.arguments[0]
  )
    return wrapped(init.arguments[0]);
  return undefined;
}

/** The functions at the top of a module that are components (an upper-case name) or the default export. */
export function componentsOf(program: Node): Fn[] {
  const out: Fn[] = [];
  const consider = (
    name: string | undefined,
    fn: Node,
    exported: boolean,
    isDefault = false,
  ) => {
    if (!name && !isDefault) return;
    if (name && !/^[A-Z]/.test(name) && !isDefault) return;
    out.push({ name: name ?? "default", node: fn, exported });
  };
  const decl = (d: Node, exported: boolean) => {
    if (d.type === "FunctionDeclaration") consider(d.id?.name, d, exported);
    else if (d.type === "VariableDeclaration")
      for (const v of d.declarations) {
        if (v.id.type !== "Identifier" || !v.init) continue;
        const fn = wrapped(v.init);
        if (fn) consider(v.id.name, fn, exported);
      }
  };
  for (const s of program.body as Node[]) {
    if (s.type === "ExportNamedDeclaration" && s.declaration)
      decl(s.declaration, true);
    else if (s.type === "ExportDefaultDeclaration") {
      const d = s.declaration;
      if (d.type === "FunctionDeclaration") consider(d.id?.name, d, true, true);
      else if (wrapped(d)) consider(undefined, wrapped(d)!, true, true);
    } else decl(s, false);
  }
  return out;
}

/** local name -> the name the module exports it under ("default" for the default export). Direct exports, `export { A as B }` and `export default A`. */
export function exportsOf(program: Node): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of program.body as Node[]) {
    if (s.type === "ExportNamedDeclaration") {
      const d = s.declaration;
      if (d?.type === "FunctionDeclaration" && d.id) out.set(d.id.name, d.id.name);
      for (const v of d?.declarations ?? [])
        if (v.id.type === "Identifier") out.set(v.id.name, v.id.name);
      if (!s.source)
        for (const sp of s.specifiers ?? [])
          out.set(sp.local.name, sp.exported.name ?? sp.exported.value);
    } else if (s.type === "ExportDefaultDeclaration") {
      const d = s.declaration;
      if (d.type === "Identifier") out.set(d.name, "default");
      else if (d.type === "FunctionDeclaration" && d.id) out.set(d.id.name, "default");
    }
  }
  return out;
}

export interface Imports {
  /** local name -> { source, imported } */
  byLocal: Map<string, { source: string; imported: string }>;
}

export function importsOf(program: Node): Imports {
  const byLocal = new Map<string, { source: string; imported: string }>();
  for (const s of program.body as Node[])
    if (s.type === "ImportDeclaration")
      for (const sp of s.specifiers)
        byLocal.set(sp.local.name, {
          source: s.source.value,
          imported:
            sp.type === "ImportSpecifier"
              ? (sp.imported.name ?? sp.imported.value)
              : sp.type === "ImportDefaultSpecifier"
                ? "default"
                : "*",
        });
  return { byLocal };
}

interface Own {
  tier: Tier;
  reasons: string[];
  /** Components this one renders, by local name, with whether each use hands it something that cannot cross to an island. */
  renders: { name: string; opaque: boolean; unanalyzable?: string }[];
}

/** What a JSX element's type names: a component to read, or something that cannot be read (chosen at run time, or a member of an object). */
function rendered(type: Node | undefined, opaque: boolean): Own["renders"] {
  if (!type || type.type === "Literal") return []; // a host element ("div")
  if (type.type === "Identifier")
    return /^[A-Z]/.test(type.name)
      ? [{ name: type.name, opaque }]
      : [
          {
            name: type.name,
            opaque,
            unanalyzable: `renders a component chosen at run time (${type.name})`,
          },
        ];
  if (type.type === "MemberExpression") {
    let root: Node = type;
    while (root.type === "MemberExpression") root = root.object;
    const name = root.type === "Identifier" ? root.name : "?";
    return [
      {
        name,
        opaque,
        unanalyzable: `renders ${name}.${type.property?.name ?? "…"}, a member of an object, which is not read`,
      },
    ];
  }
  return [
    {
      name: "?",
      opaque,
      unanalyzable: "renders a component given by an expression",
    },
  ];
}

function ownOf(fn: Node): Own {
  const reasons = new Set<string>();
  let tier: Tier = "page";
  const heavier = (t: "island" | "fallback", why: string) => {
    reasons.add(why);
    if (t === "fallback" || tier === "page") tier = t;
  };
  // In development Bun passes `this` as the last argument of every jsxDEV call; that is not the component using `this`.
  const jsxThis = new Set<Node>();
  for (const n of walk(fn))
    if (isJsxCall(n))
      for (const a of n.arguments as Node[])
        if (a.type === "ThisExpression") jsxThis.add(a);
  const renders: Own["renders"] = [];
  const declared = new Set<string>();
  for (const n of walk(fn)) {
    if (n.type === "VariableDeclarator" && n.id.type === "Identifier")
      declared.add(n.id.name);
    if (n.type === "FunctionDeclaration" && n.id) declared.add(n.id.name);
    for (const p of (n.params ?? []) as Node[])
      for (const m of walk(p))
        if (m.type === "Identifier") declared.add(m.name);
  }
  for (const n of walk(fn)) {
    if (n.type === "CallExpression") {
      const callee = nameOfCallee(n.callee);
      if (callee && /^use[A-Z]/.test(callee) && !PURE_HOOKS.has(callee))
        heavier("island", `calls ${callee}()`);
      if (callee === "createRef") heavier("island", "calls createRef()");
      if (isJsxCall(n)) {
        const [type, props] = n.arguments as Node[];
        if (props?.type === "ObjectExpression") {
          let opaque = false;
          for (const p of props.properties as Node[]) {
            const k = keyName(p);
            // Handlers on a host element are the DOM's; an on-prop on a component is only a function handed to it (counted below).
            if (k && /^on[A-Z]/.test(k) && type?.type === "Literal")
              heavier("island", `has an ${k} handler`);
            const v = p.value as Node | undefined;
            if (
              v &&
              (/^(Arrow)?FunctionExpression$/.test(v.type) ||
                (k === "children" &&
                  v.type !== "Literal" &&
                  v.type !== "Identifier" &&
                  v.type !== "MemberExpression" &&
                  v.type !== "TemplateLiteral"))
            )
              opaque = true;
            if (v && isJsxCall(v)) opaque = true;
            if (p.type === "SpreadElement") continue;
          }
          renders.push(...rendered(type, opaque));
        } else renders.push(...rendered(type, true));
      }
    }
    if (n.type === "Identifier" && GLOBALS.has(n.name) && !declared.has(n.name))
      heavier("island", `reads ${n.name}`);
    if (n.type === "ThisExpression" && !jsxThis.has(n))
      heavier("fallback", "uses `this` (a class or a bound method)");
  }
  return { tier, reasons: [...reasons], renders };
}

export const EXTS = [
  "",
  ".tsx",
  ".ts",
  ".jsx",
  ".js",
  "/index.tsx",
  "/index.ts",
  "/index.jsx",
  "/index.js",
];
export const resolveRelative = (from: string, spec: string): string | undefined => {
  const base = resolve(dirname(from), spec);
  return EXTS.map((e) => base + e).find(
    (f) => existsSync(f) && /\.[tj]sx?$/.test(f),
  );
};

/** Reports components across files: reading each file once, following relative imports to the components a component renders. */
export class Classifier {
  constructor(private readonly appRoot: string) {}
  private files = new Map<
    string,
    {
      comps: Map<string, Fn>;
      own: Map<string, Own>;
      imports: Imports;
      exports: Map<string, string>;
    } | null
  >();
  /** Islands a page renders or a route is: the ones the build mounts. By "file#name". */
  readonly mounts = new Map<string, ComponentReport>();
  private memo = new Map<string, ComponentReport>();
  private active = new Set<string>();

  private load(file: string) {
    if (this.files.has(file)) return this.files.get(file)!;
    let entry: {
      comps: Map<string, Fn>;
      own: Map<string, Own>;
      imports: Imports;
      exports: Map<string, string>;
    } | null = null;
    try {
      const program = acorn.parse(toJs(file, readFileSync(file, "utf8")), {
        ecmaVersion: "latest",
        sourceType: "module",
        allowAwaitOutsideFunction: true,
      }) as unknown as Node;
      const fns = componentsOf(program);
      entry = {
        comps: new Map(fns.map((f) => [f.name, f])),
        own: new Map(fns.map((f) => [f.name, ownOf(f.node)])),
        imports: importsOf(program),
        exports: exportsOf(program),
      };
    } catch {
      entry = null; // not parseable: callers treat the component as a fallback
    }
    this.files.set(file, entry);
    return entry;
  }

  component(file: string, name: string): ComponentReport {
    const key = `${file}#${name}`;
    const cached = this.memo.get(key);
    if (cached) return cached;
    const entry = this.load(file);
    const base = {
      name,
      file,
      islands: [] as string[],
      ...(entry?.exports.get(name) && { exportName: entry.exports.get(name) }),
    };
    if (!entry)
      return {
        ...base,
        own: "fallback",
        tier: "fallback",
        reasons: ["the file could not be read as a module"],
      };
    const own = entry.own.get(name);
    if (!own)
      return {
        ...base,
        own: "fallback",
        tier: "fallback",
        reasons: [`no component named ${name} in the file`],
      };
    if (this.active.has(key))
      return {
        ...base,
        own: own.tier,
        tier: own.tier,
        reasons: [...own.reasons, "renders itself, directly or through others"],
      };
    this.active.add(key);
    let tier = own.tier;
    const reasons = [...own.reasons];
    const islands: string[] = [];
    const mounts: ComponentReport[] = [];
    let usesOutlet = false;
    for (const r of own.renders) {
      const imp = entry.imports.byLocal.get(r.name);
      if (imp?.imported === "Outlet" && /^(@archlast\/forge-framework|react-router|react-router-dom)$/.test(imp.source)) usesOutlet = true;
      if (r.unanalyzable) {
        if (tier === "page") tier = "island";
        reasons.push(r.unanalyzable);
        continue;
      }
      let child = this.child(file, entry, r.name);
      if (!child) continue;
      if (child.usesOutlet) usesOutlet = true;
      // An island is loaded from its own module by the name it exports; used where it is declared, or not exported, it cannot be.
      if (child.tier === "island" && !child.unmountable && !isAbsolute(child.file))
        child = { ...child, unmountable: true, reasons: [child.reasons[0] ?? "is not analyzed"] };
      else if (child.tier === "island" && !child.unmountable && child.file === file && entry.comps.has(r.name))
        child = { ...child, unmountable: true, reasons: [`which is an island used in the file that declares it; put it in a file of its own`] };
      else if (child.tier === "island" && !child.unmountable && entry.comps.has(r.name) && !child.exportName)
        child = { ...child, unmountable: true, reasons: [`which is an island that its file does not export`] };
      if (child.unmountable) {
        if (tier === "page") tier = "island";
        reasons.push(`renders ${r.name}, ${child.reasons[0]}`);
      } else if (child.tier === "fallback") {
        tier = "fallback";
        reasons.push(`renders ${r.name}, which is a fallback`);
      } else if (child.tier === "island" || child.islands.length) {
        if (child.tier === "island") {
          if (r.opaque && tier === "page") {
            tier = "island";
            reasons.push(
              `passes a function or elements to ${r.name}, an island, which cannot cross to it`,
            );
          } else {
            islands.push(child.name);
            mounts.push(child);
          }
        } else islands.push(...child.islands);
      }
    }
    this.active.delete(key);
    // An island is hydrated alone, with no router around it, so an `<Outlet />` inside one would render nothing in the browser where the server rendered a page.
    if (tier === "island" && usesOutlet) {
      tier = "fallback";
      reasons.push("renders an <Outlet /> inside an island: there is no router in the browser to fill it, so this route is rendered and hydrated as a whole");
    }
    // The islands a page renders are mounted where it renders them; those inside an island are part of it.
    if (tier === "page") for (const m of mounts) this.mounts.set(`${m.file}#${m.name}`, m);
    const report: ComponentReport = {
      ...base,
      own: own.tier,
      tier,
      reasons,
      islands: [...new Set(islands)],
      ...(usesOutlet && { usesOutlet }),
    };
    this.memo.set(key, report);
    return report;
  }

  private child(
    file: string,
    entry: NonNullable<ReturnType<Classifier["load"]>>,
    local: string,
  ): ComponentReport | undefined {
    if (entry.comps.has(local)) return this.component(file, local);
    const imp = entry.imports.byLocal.get(local);
    if (!imp && /^Fragment(_\w+)?$/.test(local)) return undefined; // the transpiler's own name for <>…</>
    // Neither declared here nor imported (a local variable holding a component): there is no module to hydrate it from.
    if (!imp)
      return {
        name: local,
        file,
        own: "island",
        tier: "island",
        reasons: [`${local} is not a component declared here or imported`],
        islands: [],
        unmountable: true,
      };
    const name = imp.imported;
    const unread = (why: string): ComponentReport => ({
      name,
      file: imp.source,
      own: "island",
      tier: "island",
      reasons: [why],
      islands: [],
    });
    if (/^react\/jsx(-dev)?-runtime$/.test(imp.source)) return undefined; // what the transpiler adds
    // Components whose behavior is known by name, whether or not the package resolves to a file here.
    if (
      /^(@archlast\/forge-framework|react-router|react-router-dom)$/.test(
        imp.source,
      )
    ) {
      if (INTERACTIVE_COMPONENTS.has(name))
        return unread(`${name} from ${imp.source} is interactive`);
      if (PAGE_COMPONENTS.has(name)) return undefined;
    }
    if (imp.source === "react" && PAGE_COMPONENTS.has(name)) return undefined;
    let target: string | undefined;
    if (imp.source.startsWith(".")) target = resolveRelative(file, imp.source);
    else {
      try {
        target = Bun.resolveSync(imp.source, dirname(file));
      } catch {
        target = undefined;
      }
      // "@/x" and "~/x" as the common aliases for the app's own folder, when the tsconfig does not say.
      const alias = /^[@~]\/(.+)$/.exec(imp.source);
      if (!target && alias)
        target = [
          join(this.appRoot, "app", alias[1]!),
          join(this.appRoot, alias[1]!),
          join(this.appRoot, "src", alias[1]!),
        ]
          .flatMap((b) => EXTS.map((e) => b + e))
          .find((f) => existsSync(f) && /\.[tj]sx?$/.test(f));
      // What lives outside the app (packages) is not read.
      if (
        !target ||
        target.includes("/node_modules/") ||
        !target.startsWith(this.appRoot)
      ) {
        if (
          PURE_PACKAGE_COMPONENTS.some(
            ([pkg, names]) => pkg.test(imp.source) && names.test(name),
          )
        )
          return undefined;
        return unread(`${name} from ${imp.source} is not analyzed`);
      }
    }
    if (!target) return unread(`${imp.source} could not be resolved`);
    if (!/\.[tj]sx?$/.test(target)) return undefined; // an asset
    const loaded = this.load(target);
    if (!loaded)
      return {
        name: local,
        file: target,
        own: "fallback",
        tier: "fallback",
        reasons: ["could not be read"],
        islands: [],
      };
    const comp =
      name === "default"
        ? [...loaded.comps.values()].find((f) => this.isDefault(target!, f))
            ?.name
        : name;
    return comp && loaded.comps.has(comp)
      ? this.component(target, comp)
      : unread(`${name} is not a component in ${imp.source}`);
  }

  private defaults = new Map<string, string>();
  private isDefault(file: string, f: Fn): boolean {
    if (!this.defaults.has(file)) {
      const program = acorn.parse(toJs(file, readFileSync(file, "utf8")), {
        ecmaVersion: "latest",
        sourceType: "module",
        allowAwaitOutsideFunction: true,
      }) as unknown as Node;
      for (const s of program.body as Node[])
        if (s.type === "ExportDefaultDeclaration")
          this.defaults.set(file, s.declaration.id?.name ?? "default");
    }
    return this.defaults.get(file) === f.name;
  }

  /** The default-exported component of a module, and the other exports that matter to the render model. */
  route(file: string, id: string): RouteReport {
    const entry = this.load(file);
    if (!entry)
      return {
        id,
        file,
        tier: "fallback",
        notes: ["the file could not be read as a module"],
      };
    const def = [...entry.comps.values()].find((f) => this.isDefault(file, f));
    const notes: string[] = [];
    const program = acorn.parse(toJs(file, readFileSync(file, "utf8")), {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
    }) as unknown as Node;
    const exported = new Set<string>();
    for (const s of program.body as Node[]) {
      if (s.type === "ExportNamedDeclaration") {
        if (s.declaration?.type === "FunctionDeclaration")
          exported.add(s.declaration.id.name);
        for (const d of s.declaration?.declarations ?? [])
          if (d.id.type === "Identifier") exported.add(d.id.name);
        for (const sp of s.specifiers ?? []) exported.add(sp.exported.name);
      }
    }
    for (const n of [
      "loader",
      "authPlugins",
      "action",
      "clientLoader",
      "clientAction",
      "ErrorBoundary",
      "HydrateFallback",
      "shouldRevalidate",
      "handle",
      "meta",
      "links",
      "headers",
    ])
      if (exported.has(n)) notes.push(`exports ${n}`);
    if (!def)
      return {
        id,
        file,
        tier: "fallback",
        notes: [...notes, "no default-exported component"],
      };
    const c = this.component(file, def.name);
    if (exported.has("action") || exported.has("clientAction"))
      notes.push(
        "an action makes the route a fallback until actions have a place in the island model",
      );
    const tier =
      exported.has("action") || exported.has("clientAction")
        ? "fallback"
        : c.tier;
    // A route that is an island by itself is mounted where the router renders it.
    if (tier === "island" && id !== "root")
      this.mounts.set(`${file}#${def.name}`, { ...c, exportName: "default" });
    return { id, file, tier, component: def.name, notes };
  }

  all(): ComponentReport[] {
    return [...this.memo.values()];
  }
}

/** The report for an app directory (the one with `app/`): the root, every route, and every component read on the way. */
export function classifyApp(root: string): AppReport {
  const appDir = join(root, "app");
  const tree = scanRoutes(appDir);
  const c = new Classifier(root);
  const routes: RouteReport[] = [];
  const visit = (rs: RouteFile[]) => {
    for (const r of rs) {
      routes.push(c.route(join(appDir, r.file), r.id));
      if (r.children) visit(r.children);
    }
  };
  visit(tree.routes);
  const report: AppReport = { routes, components: [], mounts: [] };
  if (tree.root) {
    const rootFile = join(appDir, tree.root);
    report.root = c.route(rootFile, "root");
    // The document and the layout are read for what they render around every page.
    const entry = (
      c as unknown as { load(f: string): { comps: Map<string, Fn> } | null }
    ).load(rootFile);
    for (const name of entry?.comps.keys() ?? []) c.component(rootFile, name);
  }
  report.mounts = [...c.mounts.values()];
  report.components = c
    .all()
    .sort(
      (a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name),
    );
  return report;
}

export function formatReport(r: AppReport, root: string): string {
  const rel = (f: string) =>
    f.startsWith(root) ? f.slice(root.length + 1) : f;
  const line = (t: Tier, name: string, extra: string[]) =>
    `  ${t.padEnd(8)} ${name}${extra.length ? `  (${extra.join("; ")})` : ""}`;
  const out: string[] = ["Routes"];
  for (const x of [...(r.root ? [r.root] : []), ...r.routes])
    out.push(
      line(x.tier, x.id === "root" ? "root" : x.id.replace(/^\//, ""), x.notes),
    );
  out.push("", "Components");
  for (const c of r.components)
    out.push(
      line(c.tier, `${rel(c.file)} ${c.name}`, [
        ...c.reasons,
        ...(c.islands.length
          ? [
              `renders island${c.islands.length > 1 ? "s" : ""} ${c.islands.join(", ")}`,
            ]
          : []),
      ]),
    );
  const n = (t: Tier) => r.components.filter((c) => c.tier === t).length;
  out.push(
    "",
    `${n("page")} page, ${n("island")} island, ${n("fallback")} fallback`,
  );
  return out.join("\n");
}
