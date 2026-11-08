// Pages as templates: the components of a route (its root, layouts and page) read at build time and turned into the node list the engine prints (see
// crates/core/src/template.rs), for routes whose components are all pages. Only a small, clear part of React is understood; anything else throws `Unsupported`
// with the reason, and that route stays rendered by React. The reasons are what to read when a page you expected to be printed by the engine is not.
//
// Understood: function components that are `const` declarations from props, `useViewer()`, `useLoaderData()`, `useTimeZone()`, `useParams()` and one `return`;
// host elements and fragments; text and expressions made of paths, `&&`, `||`, `??`, `?:`, `!`, `===`, `!==`, `+`, template literals and `.length`;
// `list.map((item, index) => <jsx/>)`; `cond && <jsx/>`; `cond ? <a/> : <b/>`; components of the app (inlined with their props and children); `Outlet`;
// `Link` and `NavLink` with a literal path; `<title>`, `<meta>` and `<link>` (moved to the head, as React does); and calls of the app's own functions
// (`formatMoney(row.price)`), which the server runs for each row before the page is printed and whose results the template prints.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import * as acorn from "acorn";
import { componentsOf, EXTS, exportsOf, importsOf, isJsxCall, resolveRelative, toJs, type Fn, type Imports, type Node } from "./classify";

export class Unsupported extends Error {}
const no = (what: string): never => {
  throw new Unsupported(what);
};

type Ir = unknown[];
type Nodes = unknown[];

/** What a name means while a component is compiled. */
type Binding = { kind: "ir"; ir: Ir } | { kind: "nodes"; nodes: Nodes } | { kind: "props"; props: Map<string, Binding> } | { kind: "loop"; name: string };
type Env = Map<string, Binding>;

interface Module {
  file: string;
  program: Node;
  imports: Imports;
  comps: Map<string, Fn>;
  exports: Map<string, string>;
  /** Top-level `const NAME = <literal>` declarations: arrays, objects, strings, numbers. */
  consts: Map<string, unknown>;
}

export interface Host {
  /** The name the generated module gives the function. */
  alias: string;
  from: string;
  imported: string;
}

export interface Lift {
  /** Enclosing loops, outermost first: the variable and the JavaScript that gives its list. */
  loops: { name: string; list: string }[];
  field: string;
  call: string;
}

export interface Compiled {
  /** The template: nodes. */
  nodes: Nodes;
  /** JavaScript conditions over the page's data (`d`), any of which being true means this request needs React: a branch the template cannot print is taken. */
  bails: string[];
  hosts: Host[];
  lifts: Lift[];
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const UNSUPPORTED_TAGS = new Set(["script", "style", "textarea", "select", "option", "svg", "math", "iframe", "form", "template", "noscript"]);
/** Attributes that print as `name=""` when true. */
const BOOLEAN = new Set(["disabled", "readOnly", "hidden", "required", "autofocus", "noValidate", "allowFullScreen", "autoPlay", "itemScope", "async", "defer", "open", "loop", "muted", "controls", "multiple", "reversed", "default", "inert", "noModule", "formNoValidate", "playsInline"]);
/** Attributes whose true and false print as the text "true" and "false". */
const ENUMERATED = new Set(["contentEditable", "spellCheck", "draggable"]);
/** The few names React changes when it prints an attribute; every other name is printed as written. */
const RENAMED: Record<string, string> = { className: "class", htmlFor: "for", tabIndex: "tabindex", crossOrigin: "crossorigin", autoFocus: "autofocus", httpEquiv: "http-equiv", acceptCharset: "accept-charset" };
const UNITLESS = new Set(["opacity", "zIndex", "flex", "flexGrow", "flexShrink", "fontWeight", "lineHeight", "order", "zoom", "orphans", "widows", "tabSize", "columns", "gridRow", "gridColumn"]);

const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/^ms-/, "-ms-");

const modules = new Map<string, Module | null>();
/** Forget the modules read so far (a rebuild reads them again). */
export const forgetModules = () => modules.clear();
function loadModule(file: string): Module {
  let m = modules.get(file);
  if (m === undefined) {
    try {
      const program = acorn.parse(toJs(file, readFileSync(file, "utf8")), { ecmaVersion: "latest", sourceType: "module", allowAwaitOutsideFunction: true }) as unknown as Node;
      m = { file, program, imports: importsOf(program), comps: new Map(componentsOf(program).map((f) => [f.name, f])), exports: exportsOf(program), consts: constantsOf(program) };
    } catch {
      m = null;
    }
    modules.set(file, m);
  }
  return m ?? no(`${file} could not be read as a module`);
}

const NOT_A_LITERAL = Symbol("not a literal");

/** The value of a literal expression (strings, numbers, booleans, null, arrays and objects of those), or NOT_A_LITERAL. */
function literal(n: Node): unknown {
  if (n.type === "Literal" && !n.regex && typeof n.value !== "bigint") return n.value;
  if (n.type === "ArrayExpression") {
    const out: unknown[] = [];
    for (const e of n.elements as (Node | null)[]) {
      const v = e ? literal(e) : null;
      if (v === NOT_A_LITERAL) return NOT_A_LITERAL;
      out.push(v);
    }
    return out;
  }
  if (n.type === "ObjectExpression") {
    const out: Record<string, unknown> = {};
    for (const p of n.properties as Node[]) {
      if (p.type !== "Property" || p.computed) return NOT_A_LITERAL;
      const v = literal(p.value);
      if (v === NOT_A_LITERAL) return NOT_A_LITERAL;
      out[(p.key.name ?? p.key.value) as string] = v;
    }
    return out;
  }
  return NOT_A_LITERAL;
}

function constantsOf(program: Node): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const take = (d: Node) => {
    if (d?.type !== "VariableDeclaration" || d.kind !== "const") return;
    for (const v of d.declarations as Node[]) {
      if (v.id.type !== "Identifier" || !v.init) continue;
      const value = literal(v.init);
      if (value !== NOT_A_LITERAL) out.set(v.id.name, value);
    }
  };
  for (const s of program.body as Node[]) take(s.type === "ExportNamedDeclaration" ? s.declaration : s);
  return out;
}

/** What the compiler is doing: the route, the outlet, the lifted calls so far. */
interface Ctx {
  appRoot: string;
  /** The id of the route whose component is being compiled: what `useLoaderData()` means. */
  routeId: string;
  outlet: Nodes | null;
  hosts: Map<string, Host>;
  lifts: Lift[];
  hoisted: Nodes[];
  depth: number;
  /** The loops being compiled, outermost first. */
  loops: { name: string; listIr: Ir }[];
  /** The conditions of the branches being compiled, outermost first (each as it must hold for the branch to be taken). */
  guards: Ir[];
  /** Branches that could not be compiled, with the conditions that lead to them. */
  bails: Ir[][];
}

const path = (root: string, ...keys: (string | number)[]): Ir => ["p", root, ...keys];
const isPath = (ir: Ir): boolean => ir[0] === "p";

/** The JavaScript that reads a path: `d.l["routes/x"].rows`, `row.tags`. */
function jsPath(ir: Ir): string {
  if (!isPath(ir)) return no("a list must be a path to compile a call over its items");
  const [, root, ...keys] = ir as [string, string, ...(string | number)[]];
  return `${root}${keys.map((k) => (typeof k === "number" ? `?.[${k}]` : `?.[${JSON.stringify(k)}]`)).join("")}`;
}

/** The JavaScript for an expression over the page's data: the same meaning as the template's, for deciding in JavaScript what the template would decide. */
function irToJs(ir: Ir): string {
  const [op, ...a] = ir as [string, ...unknown[]];
  const x = (i: number) => irToJs(a[i] as Ir);
  switch (op) {
    case "l":
      return JSON.stringify(a[0] ?? null);
    case "p":
      return jsPath(ir);
    case "!":
      return `!(${x(0)})`;
    case "&&":
    case "||":
    case "??":
    case "===":
    case "!==":
    case "+":
    case "-":
    case "*":
    case "/":
    case "%":
    case "<":
    case ">":
    case "<=":
    case ">=":
      return `(${x(0)} ${op} ${x(1)})`;
    case "?:":
      return `(${x(0)} ? ${x(1)} : ${x(2)})`;
    case "`":
      return `(${(a[0] as Ir[]).map((p) => `String(${irToJs(p)} ?? "")`).join(" + ") || '""'})`;
    default:
      return no(`the operator ${op} in a condition that decides whether React is needed`);
  }
}

/** Compiles a branch; if it cannot be, the page needs React whenever the branch is taken, which is decided per request from the conditions around it. */
function branch(cond: Ir, taken: boolean, ctx: Ctx, compile: () => Nodes): Nodes {
  const saved = { hoisted: ctx.hoisted.length, lifts: ctx.lifts.length, guards: ctx.guards.length };
  ctx.guards.push(taken ? cond : ["!", cond]);
  try {
    return compile();
  } catch (e) {
    if (!(e instanceof Unsupported) || ctx.loops.length > 0) throw e;
    ctx.bails.push([...ctx.guards]);
    ctx.hoisted.length = saved.hoisted;
    ctx.lifts.length = saved.lifts;
    return [];
  } finally {
    ctx.guards.length = saved.guards;
  }
}

function resolveModule(from: string, spec: string, appRoot: string): string | undefined {
  let target: string | undefined;
  if (spec.startsWith(".")) target = resolveRelative(from, spec);
  else {
    try {
      target = Bun.resolveSync(spec, dirname(from));
    } catch {
      const alias = /^[@~]\/(.+)$/.exec(spec);
      if (alias) target = [join(appRoot, "app", alias[1]!), join(appRoot, alias[1]!), join(appRoot, "src", alias[1]!)].flatMap((b) => EXTS.map((e) => b + e)).find((f) => existsSync(f) && /\.[tj]sx?$/.test(f));
    }
  }
  return target && !target.includes("/node_modules/") && target.startsWith(appRoot) && /\.[tj]sx?$/.test(target) ? target : undefined;
}

// ---------- expressions ----------

function expression(n: Node, env: Env, ctx: Ctx, mod: Module): Ir {
  switch (n.type) {
    case "Literal":
      if (n.regex || typeof n.value === "bigint") return no("a regular expression or bigint");
      return ["l", n.value];
    case "Identifier": {
      if (n.name === "undefined") return ["l", null];
      const b = env.get(n.name);
      if (!b) return mod.consts.has(n.name) ? ["l", mod.consts.get(n.name)] : no(`${n.name} is not something a template knows`);
      if (b.kind === "ir") return b.ir;
      if (b.kind === "loop") return path(b.name);
      return no(`${n.name} is used as a value but is ${b.kind}`);
    }
    case "ChainExpression":
      return expression(n.expression, env, ctx, mod);
    case "MemberExpression": {
      if (n.object.type === "Identifier" && env.get(n.object.name)?.kind === "props") {
        const props = (env.get(n.object.name) as { props: Map<string, Binding> }).props;
        const key = n.computed ? no("a computed prop") : n.property.name;
        const b = props.get(key as string);
        if (!b) return ["l", null];
        if (b.kind !== "ir") return no(`prop ${String(key)} is not a value`);
        return b.ir;
      }
      const obj = expression(n.object, env, ctx, mod);
      if (obj[0] === "l" && !n.computed) {
        const v = obj[1] as Record<string, unknown> | unknown[] | string | null;
        return ["l", v !== null && v !== undefined && n.property.name in Object(v) ? (Object(v) as Record<string, unknown>)[n.property.name] : n.property.name === "length" && typeof v === "string" ? v.length : null];
      }
      if (!isPath(obj)) return no("a member of something that is not data");
      const key = n.computed ? (n.property.type === "Literal" && (typeof n.property.value === "string" || Number.isInteger(n.property.value)) ? n.property.value : no("a computed key")) : n.property.name;
      return [...obj, key];
    }
    case "LogicalExpression": {
      const op = n.operator === "&&" || n.operator === "||" || n.operator === "??" ? n.operator : no(`operator ${n.operator}`);
      return [op, expression(n.left, env, ctx, mod), expression(n.right, env, ctx, mod)];
    }
    case "ConditionalExpression":
      return ["?:", expression(n.test, env, ctx, mod), expression(n.consequent, env, ctx, mod), expression(n.alternate, env, ctx, mod)];
    case "UnaryExpression":
      if (n.operator === "!") return ["!", expression(n.argument, env, ctx, mod)];
      return no(`operator ${n.operator}`);
    case "BinaryExpression": {
      if (["===", "!==", "+", "<", ">", "<=", ">=", "-", "*", "/", "%"].includes(n.operator)) return [n.operator, expression(n.left, env, ctx, mod), expression(n.right, env, ctx, mod)];
      if ((n.operator === "==" || n.operator === "!=") && ((n.right.type === "Literal" && n.right.value === null) || (n.left.type === "Literal" && n.left.value === null))) {
        // `x == null` is true for null and undefined, which are one thing in the data
        const x = expression(n.right.type === "Literal" ? n.left : n.right, env, ctx, mod);
        return n.operator === "==" ? ["===", x, ["l", null]] : ["!==", x, ["l", null]];
      }
      return no(`operator ${n.operator}`);
    }
    case "TemplateLiteral": {
      const parts: Ir[] = [];
      n.quasis.forEach((q: Node, i: number) => {
        if (q.value.cooked) parts.push(["l", q.value.cooked]);
        if (i < n.expressions.length) parts.push(expression(n.expressions[i], env, ctx, mod));
      });
      return ["`", parts];
    }
    case "CallExpression":
      return call(n, env, ctx, mod);
    default:
      return no(`${n.type} in an expression`);
  }
}

/** A call of one of the app's functions: it runs on the server before the page is printed, and the template prints what it returned. */
function call(n: Node, env: Env, ctx: Ctx, mod: Module): Ir {
  if (n.callee.type !== "Identifier") return no("a call of something that is not a plain function name");
  const name = n.callee.name as string;
  if (env.has(name)) return no(`${name}() is a variable, not one of the app's functions`);
  const imp = mod.imports.byLocal.get(name);
  const own = !imp && mod.exports.has(name) && !mod.comps.has(name);
  if (!imp && !own) return no(`${name}() is not imported from a module of the app`);
  let from: string | undefined;
  let imported = name;
  if (imp) {
    from = resolveModule(mod.file, imp.source, ctx.appRoot);
    imported = imp.imported;
    if (!from) return no(`${name}() comes from ${imp.source}, which is not a module of the app`);
  } else {
    from = mod.file;
    imported = mod.exports.get(name)!;
  }
  const key = `${from}#${imported}`;
  let host = ctx.hosts.get(key);
  if (!host) ctx.hosts.set(key, (host = { alias: `h${ctx.hosts.size}_${name.replace(/\W/g, "")}`, from, imported }));
  // Arguments are read by JavaScript, so they may be literals and paths over the loops' variables or the data, nothing more.
  const used = new Set<string>();
  const js = (a: Node): string => {
    if (a.type === "Literal") return JSON.stringify(a.value);
    if (a.type === "ChainExpression") return js(a.expression);
    if (a.type === "Identifier" || a.type === "MemberExpression") {
      const ir = expression(a, env, ctx, mod);
      if (!isPath(ir)) return no("an argument of a call that is not a path");
      used.add(ir[1] as string);
      return jsPath(ir);
    }
    return no(`${a.type} as an argument of ${name}()`);
  };
  const args = (n.arguments as Node[]).map(js);
  const call = `${host.alias}(${args.join(", ")})`;
  const loops = ctx.loops;
  // The innermost loop whose variable the arguments use decides where the result lives; with none, it is a field of the data.
  let at = -1;
  loops.forEach((l, i) => {
    if (used.has(l.name)) at = i;
  });
  const field = `__h${ctx.lifts.length}`;
  if (at < 0) {
    ctx.lifts.push({ loops: [], field: `d.${field}`, call });
    return path("d", field);
  }
  ctx.lifts.push({ loops: loops.slice(0, at + 1).map((l) => ({ name: l.name, list: jsPath(l.listIr) })), field: `${loops[at]!.name}.${field}`, call });
  return path(loops[at]!.name, field);
}

// ---------- JSX ----------

const jsxType = (n: Node): Node => n.arguments[0];
const jsxProps = (n: Node): Node[] => {
  const p = n.arguments[1];
  if (!p || p.type !== "ObjectExpression") return no("props that are not an object literal");
  return p.properties;
};

/** The children of an element, as nodes. */
function childNodes(c: Node | undefined, env: Env, ctx: Ctx, mod: Module): Nodes {
  if (!c) return [];
  switch (c.type) {
    case "Literal":
      if (c.value === null || typeof c.value === "boolean") return [];
      return [escapeText(String(c.value))];
    case "ArrayExpression":
      return c.elements.flatMap((e: Node | null) => (e ? childNodes(e, env, ctx, mod) : []));
    case "CallExpression":
      if (isJsxCall(c)) return element(c, env, ctx, mod);
      if (c.callee.type === "MemberExpression" && !c.callee.computed && c.callee.property.name === "map") return mapNodes(c, env, ctx, mod);
      return [["x", call(c, env, ctx, mod)]];
    case "LogicalExpression":
      if (c.operator === "&&" && mightBeNodes(c.right)) {
        const test = expression(c.left, env, ctx, mod);
        return [["if", test, branch(test, true, ctx, () => childNodes(c.right, env, ctx, mod)), []]];
      }
      return [["x", expression(c, env, ctx, mod)]];
    case "ConditionalExpression":
      if (mightBeNodes(c.consequent) || mightBeNodes(c.alternate)) {
        const test = expression(c.test, env, ctx, mod);
        return [["if", test, branch(test, true, ctx, () => childNodes(c.consequent, env, ctx, mod)), branch(test, false, ctx, () => childNodes(c.alternate, env, ctx, mod))]];
      }
      return [["x", expression(c, env, ctx, mod)]];
    case "Identifier": {
      const b = env.get(c.name);
      if (b?.kind === "nodes") return b.nodes;
      return [["x", expression(c, env, ctx, mod)]];
    }
    case "MemberExpression": {
      if (c.object.type === "Identifier" && env.get(c.object.name)?.kind === "props") {
        const b = (env.get(c.object.name) as { props: Map<string, Binding> }).props.get(c.property.name);
        if (b?.kind === "nodes") return b.nodes;
        if (!b) return [];
      }
      return [["x", expression(c, env, ctx, mod)]];
    }
    default:
      return [["x", expression(c, env, ctx, mod)]];
  }
}

const mightBeNodes = (n: Node): boolean => n.type === "CallExpression" || n.type === "ArrayExpression" || n.type === "LogicalExpression" || n.type === "ConditionalExpression" || (n.type === "Literal" && (n.value === null || typeof n.value === "boolean"));

function mapNodes(c: Node, env: Env, ctx: Ctx, mod: Module): Nodes {
  const cb = c.arguments[0];
  if (!cb || (cb.type !== "ArrowFunctionExpression" && cb.type !== "FunctionExpression") || c.arguments.length !== 1) return no("a .map() that is not given one function");
  const params = cb.params as Node[];
  if (params.length < 1 || params.length > 2 || !["Identifier", "ArrayPattern", "ObjectPattern"].includes(params[0]!.type) || (params[1] && params[1].type !== "Identifier")) return no("a .map() callback with a parameter it cannot read");
  const listIr = expression(c.callee.object, env, ctx, mod);
  if (!isPath(listIr) && listIr[0] !== "l") return no("a .map() over something that is not data");
  const item = params[0]!.type === "Identifier" ? (params[0]!.name as string) : `it${ctx.loops.length}_${params.length}`;
  const index = params[1]?.name as string | undefined;
  const inner = new Map(env);
  inner.set(item, { kind: "loop", name: item });
  if (params[0]!.type !== "Identifier") bindIr(params[0]!, path(item), inner);
  if (index) inner.set(index, { kind: "ir", ir: path(index) });
  ctx.loops.push({ name: item, listIr });
  try {
    const body = cb.body.type === "BlockStatement" ? returned(cb.body, inner, ctx, mod) : cb.body;
    return [["map", listIr, item, index ?? null, childNodes(body, inner, ctx, mod)]];
  } finally {
    ctx.loops.pop();
  }
}

/** The expression a block returns, when the block is only that (and `const` declarations, which are not understood here). */
function returned(block: Node, _env: Env, _ctx: Ctx, _mod: Module): Node {
  const body = block.body as Node[];
  if (body.length !== 1 || body[0]!.type !== "ReturnStatement" || !body[0]!.argument) return no("a callback that is more than a return");
  return body[0]!.argument;
}

function attributeName(raw: string): { name: string; mode: boolean | "enum" } {
  if (raw.startsWith("data-") || raw.startsWith("aria-")) return { name: raw, mode: false };
  const name = RENAMED[raw] ?? raw;
  if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(name) || raw.startsWith("xlink") || raw.startsWith("xml") || raw === "is" || raw === "inert" && false) return no(`the attribute ${raw}`);
  return { name, mode: ENUMERATED.has(raw) ? "enum" : BOOLEAN.has(name) || BOOLEAN.has(raw) };
}

function styleString(v: Node): string {
  if (v.type !== "ObjectExpression") return no("a style that is not an object literal");
  return (v.properties as Node[])
    .map((p) => {
      if (p.type !== "Property" || p.computed || p.value.type !== "Literal") return no("a style with a value that is not a literal");
      const key = (p.key.name ?? p.key.value) as string;
      const val = p.value.value;
      if (val === null || typeof val === "boolean") return "";
      if (typeof val === "number") return `${kebab(key)}:${val === 0 || UNITLESS.has(key) ? val : `${val}px`}`;
      return `${kebab(key)}:${val}`;
    })
    .filter(Boolean)
    .join(";");
}

/** Attributes of a host element, as nodes. */
function attributes(props: Node[], env: Env, ctx: Ctx, mod: Module, skip: Set<string>): Nodes {
  const out: Nodes = [];
  for (const p of props) {
    if (p.type !== "Property" || p.computed) return no("a spread or computed prop");
    const raw = (p.key.name ?? p.key.value) as string;
    if (raw === "children" || skip.has(raw)) continue;
    if (raw === "key") continue;
    if (raw === "ref" || raw === "dangerouslySetInnerHTML" || raw === "suppressHydrationWarning" || raw === "value" || raw === "defaultValue" || raw === "defaultChecked" || /^on[A-Z]/.test(raw)) return no(`the prop ${raw}`);
    if (raw === "style") {
      const css = styleString(p.value);
      if (css) out.push(` style="${escapeText(css)}"`);
      continue;
    }
    const { name, mode } = attributeName(raw);
    if (p.value.type === "Literal") {
      const v = p.value.value;
      if (v === null) continue;
      if (typeof v === "boolean") {
        if (mode === "enum") out.push(` ${name}="${v}"`);
        else if (v && mode) out.push(` ${name}=""`);
        else if (v && (name.startsWith("aria-") || name.startsWith("data-"))) out.push(` ${name}="true"`);
        else if (!v && (name.startsWith("aria-") || name.startsWith("data-"))) out.push(` ${name}="false"`);
        continue;
      }
      out.push(` ${name}="${escapeText(String(v))}"`);
    } else out.push(["a", name, expression(p.value, env, ctx, mod), mode]);
  }
  return out;
}

function element(n: Node, env: Env, ctx: Ctx, mod: Module): Nodes {
  const type = jsxType(n);
  const props = jsxProps(n);
  const children = props.find((p) => p.type === "Property" && !p.computed && (p.key.name ?? p.key.value) === "children")?.value as Node | undefined;
  if (type.type === "Literal" && typeof type.value === "string") return host(type.value, props, children, env, ctx, mod);
  if (type.type === "Identifier") return component(type.name, props, children, env, ctx, mod);
  return no("an element whose type is an expression");
}

function host(tag: string, props: Node[], children: Node | undefined, env: Env, ctx: Ctx, mod: Module): Nodes {
  if (UNSUPPORTED_TAGS.has(tag)) return no(`the element <${tag}>`);
  const hoistable = tag === "title" || tag === "meta" || tag === "link";
  const attrs = attributes(props, env, ctx, mod, new Set());
  if (tag === "link" && !props.some((p) => (p.key?.name ?? p.key?.value) === "rel")) return no("a <link> without rel");
  if (VOID.has(tag)) {
    if (children) return no(`children of <${tag}>`);
    const node = [`<${tag}`, ...attrs, "/>"];
    if (hoistable) {
      ctx.hoisted.push(node);
      return [];
    }
    return node;
  }
  const inner = tag === "head" ? [...childNodes(children, env, ctx, mod), { head: true }] : tag === "body" ? [...childNodes(children, env, ctx, mod), ["raw", path("d", "bodyEnd")]] : childNodes(children, env, ctx, mod);
  const node = [`<${tag}`, ...attrs, ">", ...inner, `</${tag}>`];
  if (hoistable) {
    ctx.hoisted.push(node);
    return [];
  }
  return node;
}

function component(name: string, props: Node[], children: Node | undefined, env: Env, ctx: Ctx, mod: Module): Nodes {
  if (/^Fragment(_\w+)?$/.test(name)) return childNodes(children, env, ctx, mod);
  const imp = mod.imports.byLocal.get(name);
  const known = imp && /^(@archlast\/forge-framework|react-router|react-router-dom)$/.test(imp.source) ? imp.imported : undefined;
  if (known === "Outlet") return ctx.outlet ?? no("an <Outlet /> outside a layout");
  if (known === "Link" || known === "NavLink") return link(known, props, children, env, ctx, mod);
  if (known) return no(`${known} from ${imp!.source}`);
  // a component of the app
  let target: { mod: Module; fn: Fn } | undefined;
  if (mod.comps.has(name)) target = { mod, fn: mod.comps.get(name)! };
  else if (imp) {
    const file = resolveModule(mod.file, imp.source, ctx.appRoot);
    if (!file) return no(`${name} comes from ${imp.source}, which is not a module of the app`);
    const m = loadModule(file);
    const local = [...m.exports].find(([, exp]) => exp === imp.imported)?.[0];
    const fn = local ? m.comps.get(local) : undefined;
    if (!fn) return no(`${name} is not a component in ${imp.source}`);
    target = { mod: m, fn };
  }
  if (!target) return no(`${name} is not a component the template can read`);
  if (ctx.depth > 40) return no("components nested too deeply");
  const given = new Map<string, Binding>();
  for (const p of props) {
    if (p.type !== "Property" || p.computed) return no("a spread or computed prop on a component");
    const key = (p.key.name ?? p.key.value) as string;
    if (key === "key") continue;
    if (key === "children") given.set("children", { kind: "nodes", nodes: childNodes(p.value, env, ctx, mod) });
    else if (p.value.type === "CallExpression" && isJsxCall(p.value)) given.set(key, { kind: "nodes", nodes: element(p.value, env, ctx, mod) });
    else given.set(key, { kind: "ir", ir: expression(p.value, env, ctx, mod) });
  }
  return run(target.mod, target.fn.node, given, ctx);
}

function link(kind: "Link" | "NavLink", props: Node[], children: Node | undefined, env: Env, ctx: Ctx, mod: Module): Nodes {
  const to = props.find((p) => (p.key?.name ?? p.key?.value) === "to")?.value as Node | undefined;
  if (!to || to.type !== "Literal" || typeof to.value !== "string" || !/^\/[^?#%\\]*$/.test(to.value) || (to.value !== "/" && to.value.endsWith("/")) || to.value.includes("//") || /\/\.{1,2}(\/|$)/.test(to.value)) return no(`${kind} needs a literal path like "/products"`);
  const others = props.filter((p) => !["to", "end", "className", "children", "key"].includes(p.key?.name ?? p.key?.value));
  if (others.some((p) => ["replace", "state", "reloadDocument", "preventScrollReset", "relative", "viewTransition", "discover", "prefetch", "target", "download", "caseSensitive", "style"].includes(p.key?.name ?? p.key?.value))) return no(`${kind} with an option`);
  const attrs = attributes(others, env, ctx, mod, new Set());
  const cls = props.find((p) => (p.key?.name ?? p.key?.value) === "className")?.value as Node | undefined;
  const out: Nodes = ["<a", ...attrs, ` href="${escapeText(to.value)}" data-discover="true"`];
  if (kind === "Link") {
    if (cls) out.push(...attributes([props.find((p) => (p.key?.name ?? p.key?.value) === "className")!], env, ctx, mod, new Set()));
  } else {
    const endProp = props.find((p) => (p.key?.name ?? p.key?.value) === "end")?.value as Node | undefined;
    if (endProp && (endProp.type !== "Literal" || typeof endProp.value !== "boolean")) return no("NavLink end that is not a literal");
    const active = ["act", to.value, Boolean(endProp?.value)];
    if (cls && (cls.type !== "Literal" || typeof cls.value !== "string")) return no("NavLink with a className that is not a string literal");
    const base = cls ? (cls.value as string) : "";
    out.push(["a", "aria-current", ["?:", active, ["l", "page"], ["l", null]], false]);
    out.push(["a", "class", ["?:", active, ["l", base ? `${base} active` : "active"], ["l", base]], false]);
  }
  out.push(">", ...childNodes(children, env, ctx, mod), "</a>");
  return out;
}

// ---------- components ----------

const HOOKS: Record<string, (ctx: Ctx) => Ir> = {
  useViewer: () => path("d", "viewer"),
  useLoaderData: (ctx) => path("d", "l", ctx.routeId),
  useTimeZone: () => path("d", "tz"),
  useParams: () => path("d", "params"),
};

/** Binds the names a declaration makes: `const x = e`, `const { a, b } = e`. */
function declare(id: Node, init: Node, env: Env, ctx: Ctx, mod: Module) {
  if (init.type === "CallExpression" && init.callee.type === "Identifier") {
    const imp = mod.imports.byLocal.get(init.callee.name);
    const hookName = imp?.imported ?? init.callee.name;
    if (HOOKS[hookName] && (!imp || /^(@archlast\/forge-framework|react-router)$/.test(imp.source))) {
      bindIr(id, HOOKS[hookName]!(ctx), env);
      return;
    }
  }
  bindIr(id, expression(init, env, ctx, mod), env);
}

function bindIr(id: Node, ir: Ir, env: Env) {
  if (id.type === "Identifier") return void env.set(id.name, { kind: "ir", ir });
  if (id.type === "ObjectPattern") {
    if (!isPath(ir)) return no("a destructuring of something that is not data");
    for (const p of id.properties as Node[]) {
      if (p.type !== "Property" || p.computed || p.value.type !== "Identifier") return no("a destructuring with a default, rest or nested pattern");
      env.set(p.value.name, { kind: "ir", ir: [...ir, p.key.name ?? p.key.value] });
    }
    return;
  }
  if (id.type === "ArrayPattern") {
    if (!isPath(ir)) return no("a destructuring of something that is not data");
    (id.elements as (Node | null)[]).forEach((e, i) => {
      if (!e) return;
      if (e.type !== "Identifier") return no("an array pattern with a default, rest or nested pattern");
      env.set(e.name, { kind: "ir", ir: [...ir, i] });
    });
    return;
  }
  return no(`${id.type} as the target of a declaration`);
}

/** Compiles one use of a component: its parameters are bound to what the caller gave, and its body is its `const`s and one `return`. */
function run(mod: Module, fn: Node, given: Map<string, Binding>, ctx: Ctx): Nodes {
  const env: Env = new Map();
  const param = (fn.params as Node[])[0];
  if (param) {
    if (param.type === "Identifier") env.set(param.name, { kind: "props", props: given });
    else if (param.type === "ObjectPattern") {
      for (const p of param.properties as Node[]) {
        if (p.type !== "Property" || p.computed || p.value.type !== "Identifier") return no("props destructured with a default, rest or nested pattern");
        const key = (p.key.name ?? p.key.value) as string;
        env.set(p.value.name, given.get(key) ?? { kind: "ir", ir: ["l", null] });
      }
    } else return no("a parameter that is a pattern");
  }
  const saved = { routeId: ctx.routeId };
  ctx.depth++;
  try {
    let body: Node;
    if (fn.body.type === "BlockStatement") {
      let ret: Node | undefined;
      for (const s of fn.body.body as Node[]) {
        if (s.type === "VariableDeclaration" && s.kind === "const") for (const d of s.declarations as Node[]) declare(d.id, d.init ?? no("a declaration without a value"), env, ctx, mod);
        else if (s.type === "ReturnStatement" && s.argument) ret = s.argument;
        else if (s.type === "ExpressionStatement" && s.directive) continue;
        else return no(`${s.type} in a component`);
      }
      body = ret ?? no("a component that returns nothing");
    } else body = fn.body;
    return childNodes(body, env, ctx, mod);
  } finally {
    ctx.depth--;
    ctx.routeId = saved.routeId;
  }
}

// ---------- routes ----------

export interface ChainLink {
  /** The route's id as the framework knows it ("root" for app/root.tsx). */
  id: string;
  file: string;
}

/**
 * Compiles the page of one route: `chain` is the root, the layouts and the route, outermost first. The root's `Layout` (the document) wraps the root's component, which
 * contains the first `Outlet`; each next component is the outlet of the one before.
 */
export function compileChain(appRoot: string, chain: ChainLink[]): Compiled {
  const ctx: Ctx = { appRoot, routeId: "", outlet: null, hosts: new Map(), lifts: [], hoisted: [], depth: 0, loops: [], guards: [], bails: [] };
  const rootLink = chain[0];
  if (!rootLink || rootLink.id !== "root") return no("the app has no app/root.tsx");
  const rootMod = loadModule(rootLink.file);
  const layout = rootMod.comps.get("Layout") ?? no("app/root.tsx has no Layout export");
  const rootComp = [...rootMod.comps.values()].find((f) => rootMod.exports.get(f.name) === "default");

  // inside out: the page, then each layout around it, then the root
  let inner: Nodes | null = null;
  for (let i = chain.length - 1; i >= 1; i--) {
    const link = chain[i]!;
    const m = loadModule(link.file);
    const def = [...m.comps.values()].find((f) => m.exports.get(f.name) === "default") ?? no(`${relative(appRoot, link.file)} has no default component`);
    ctx.routeId = link.id;
    ctx.outlet = inner;
    inner = run(m, def.node, new Map(), ctx);
  }
  ctx.routeId = "root";
  ctx.outlet = inner;
  const app: Nodes = rootComp ? run(rootMod, rootComp.node, new Map(), ctx) : (inner ?? []);
  ctx.outlet = null;
  const document = run(rootMod, layout.node, new Map([["children", { kind: "nodes", nodes: app }]]), ctx);
  const nodes = withHead(document, ctx.hoisted);
  const bails = ctx.bails.map((g) => g.map((c) => `(${irToJs(c)})`).join(" && "));
  return { nodes: ["<!DOCTYPE html>", ...nodes], bails, hosts: [...ctx.hosts.values()], lifts: ctx.lifts };
}

/** Puts what React would hoist into the head, and the framework's own head content after the document's. */
function withHead(nodes: Nodes, hoisted: Nodes[]): Nodes {
  let found = false;
  const walkNodes = (list: Nodes): Nodes =>
    list.flatMap((n) => {
      if (n && typeof n === "object" && !Array.isArray(n) && (n as { head?: boolean }).head) {
        found = true;
        return [["raw", path("d", "headEnd")], ...hoisted.flat()];
      }
      if (Array.isArray(n)) {
        if (n[0] === "if") return [["if", n[1], walkNodes(n[2] as Nodes), walkNodes(n[3] as Nodes)]];
        if (n[0] === "map") return [["map", n[1], n[2], n[3], walkNodes(n[4] as Nodes)]];
      }
      return [n];
    });
  const out = walkNodes(nodes);
  return found ? out : no("the document has no <head>");
}

/** The generated module's source: the host functions, the templates and the code that computes the called functions' results before a page is printed. */
export function moduleSource(genDir: string, compiled: Map<string, Compiled>): string {
  const hosts = new Map<string, Host>();
  for (const c of compiled.values()) for (const h of c.hosts) hosts.set(`${h.from}#${h.imported}`, h);
  const aliasOf = new Map([...hosts.values()].map((h) => [`${h.from}#${h.imported}`, h.alias]));
  const imports = [...hosts.values()].map((h) => {
    const spec = relative(genDir, h.from).split(sep).join("/").replace(/\.(tsx|ts|jsx|js)$/, "");
    return `import { ${h.imported === "default" ? "default as " : `${h.imported} as `}${h.alias} } from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)};`;
  });
  const entries = [...compiled].map(([route, c]) => {
    const rename = (call: string, h: Host[]) => h.reduce((s, x) => s.replaceAll(`${x.alias}(`, `${aliasOf.get(`${x.from}#${x.imported}`)}(`), call);
    const prep = c.lifts.map((l) => {
      const body = `${l.field} = ${rename(l.call, c.hosts)};`;
      return l.loops.reduceRight((inner, loop) => `for (const ${loop.name} of ${loop.list} ?? []) { ${inner} }`, body);
    });
    return `  { route: ${JSON.stringify(route)}, template: ${JSON.stringify(c.nodes)}, prep: ${prep.length ? `(d: any) => { ${prep.join(" ")} }` : "undefined"}, bail: ${c.bails.length ? `(d: any) => ${c.bails.map((b) => `(${b})`).join(" || ")}` : "undefined"} },`;
  });
  return `// Generated by archlast-forge from app/. Don't edit; it is rewritten on every build.
${imports.join("\n")}

export const templates: { route: string; template: unknown[]; prep?: (d: any) => void; bail?: (d: any) => boolean }[] = [
${entries.join("\n")}
];
`;
}


export interface AppTemplates {
  compiled: Map<string, Compiled>;
  /** Why a route is not printed by the engine. */
  reasons: Map<string, string>;
}

/** Compiles every route of an app that can be: `tree` is the scanned route tree, `rootFile` the absolute path of app/root.tsx. */
export function compileApp(appRoot: string, appDir: string, tree: { root?: string; routes: RouteLike[] }, tierOf: (id: string) => string | undefined): AppTemplates {
  forgetModules();
  const compiled = new Map<string, Compiled>();
  const reasons = new Map<string, string>();
  const rootLink: ChainLink | undefined = tree.root ? { id: "root", file: join(appDir, tree.root) } : undefined;
  const visit = (routes: RouteLike[], parents: ChainLink[]) => {
    for (const r of routes) {
      const link = { id: r.id, file: join(appDir, r.file) };
      if (r.children?.length) visit(r.children, [...parents, link]);
      else {
        try {
          if (!rootLink) no("the app has no app/root.tsx");
          for (const l of [rootLink!, ...parents, link]) if (tierOf(l.id) !== "page") no(`${l.id === "root" ? "app/root.tsx" : l.id} is not a page (${tierOf(l.id) ?? "unknown"})`);
          compiled.set(r.id, compileChain(appRoot, [rootLink!, ...parents, link]));
        } catch (e) {
          if (!(e instanceof Unsupported)) throw e;
          reasons.set(r.id, e.message);
        }
      }
    }
  };
  visit(tree.routes, []);
  return { compiled, reasons };
}

interface RouteLike {
  id: string;
  file: string;
  children?: RouteLike[];
}
