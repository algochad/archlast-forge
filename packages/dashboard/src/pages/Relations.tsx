import { useMemo, useState } from "react";
import { typeOf, type Manifest, type TableInfo } from "../api";
import { Icon } from "../brand";
import { incomingOf, indexFor, refsOf } from "../relations";
import { Badge, Button, Empty, Segmented } from "../ui";

const builtIn = (name: string, t: TableInfo) => !t.strict || name.startsWith("_");

const W = 230;
const HEAD = 38;
const ROW = 22;
const PAD = 28;
const GAP_X = 165;
const GAP_Y = 30;
const MAX_ROWS = 9;

type Row = { name: string; type: string; ref: boolean };
type Node = { name: string; layer: number; x: number; y: number; h: number; rows: Row[]; extra: number; builtin: boolean };
type Edge = { id: string; table: string; field: string; target: string; many: boolean; d: string; mx: number; my: number };

/** Boxes in columns, with the tables that refer to others on the left and the ones they refer to on the right. */
function layout(manifest: Manifest, names: string[]) {
  const set = new Set(names);
  const rels = names.flatMap((table) =>
    refsOf(manifest.tables[table]!)
      .filter((r) => set.has(r.target))
      .map((r) => ({ ...r, table })),
  );

  // How many hops of references a table has before reaching one that refers to nothing (a cycle stops growing at the table count).
  const depth = new Map(names.map((n) => [n, 0]));
  for (let i = 0; i < names.length; i++) {
    let changed = false;
    for (const n of names) {
      const d = Math.max(0, ...rels.filter((r) => r.table === n && r.target !== n).map((r) => depth.get(r.target)! + 1));
      if (d > depth.get(n)! && d <= names.length) (depth.set(n, d), (changed = true));
    }
    if (!changed) break;
  }
  const maxDepth = Math.max(0, ...depth.values());
  const layers: string[][] = Array.from({ length: maxDepth + 1 }, () => []);
  for (const n of [...names].sort()) layers[maxDepth - depth.get(n)!]!.push(n);

  // Keep related tables level with each other: order each column by where its neighbours sit in the one before.
  const rank = new Map<string, number>();
  layers[0]!.forEach((n, i) => rank.set(n, i));
  for (let l = 1; l < layers.length; l++) {
    const score = (n: string) => {
      const rs = rels.filter((r) => (r.table === n && rank.has(r.target)) || (r.target === n && rank.has(r.table))).map((r) => rank.get(r.table === n ? r.target : r.table)!);
      return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 1e9;
    };
    layers[l]!.sort((a, b) => score(a) - score(b) || a.localeCompare(b));
    layers[l]!.forEach((n, i) => rank.set(n, i));
  }

  const nodes = new Map<string, Node>();
  const heights = layers.map((layer) =>
    layer.reduce((h, name) => {
      const info = manifest.tables[name]!;
      const fields = Object.entries(info.fields);
      const refNames = new Set(refsOf(info).map((r) => r.field));
      // Always show references; fill the rest up to the limit, in schema order.
      const room = Math.max(0, MAX_ROWS - 1 - refNames.size);
      let spare = room;
      const shown = fields.filter(([f]) => refNames.has(f) || spare-- > 0);
      const rows: Row[] = [{ name: "_id", type: `Id<"${name}">`, ref: false }, ...shown.map(([f, v]) => ({ name: f, type: typeOf(v), ref: refNames.has(f) }))];
      const extra = fields.length - shown.length;
      const node: Node = { name, layer: 0, x: 0, y: 0, h: HEAD + (rows.length + (extra ? 1 : 0)) * ROW + 12, rows, extra, builtin: builtIn(name, info) };
      nodes.set(name, node);
      return h + node.h + GAP_Y;
    }, -GAP_Y),
  );
  const tallest = Math.max(0, ...heights);
  layers.forEach((layer, l) => {
    let y = PAD + (tallest - heights[l]!) / 2;
    for (const name of layer) {
      const node = nodes.get(name)!;
      Object.assign(node, { layer: l, x: PAD + l * (W + GAP_X), y });
      y += node.h + GAP_Y;
    }
  });

  const edges: Edge[] = rels.map((r) => {
    const from = nodes.get(r.table)!;
    const to = nodes.get(r.target)!;
    const row = from.rows.findIndex((x) => x.name === r.field);
    const sy = from.y + HEAD + (Math.max(0, row) + 0.5) * ROW;
    const ty = to.y + HEAD / 2;
    let sx: number, tx: number, c1: number, c2: number;
    if (from.layer < to.layer) ((sx = from.x + W), (tx = to.x), (c1 = (tx - sx) / 2), (c2 = -(tx - sx) / 2));
    else if (from.layer > to.layer) ((sx = from.x), (tx = to.x + W), (c1 = -(sx - tx) / 2), (c2 = (sx - tx) / 2));
    else ((sx = from.x + W), (tx = to.x + W), (c1 = 80), (c2 = 80)); // same column, or a table pointing at itself: loop out to the right
    return {
      id: `${r.table}.${r.field}`,
      table: r.table,
      field: r.field,
      target: r.target,
      many: r.many,
      d: `M${sx},${sy} C${sx + c1},${sy} ${tx + c2},${ty} ${tx},${ty}`,
      mx: (sx + tx) / 2 + (from.layer === to.layer ? 56 : 0),
      my: (sy + ty) / 2,
    };
  });

  return { nodes: [...nodes.values()], edges, width: PAD * 2 + layers.length * W + (layers.length - 1) * GAP_X + 70, height: tallest + PAD * 2 };
}

export function RelationsView({
  manifest,
  counts,
  onOpenTable,
  onQuery,
}: {
  manifest: Manifest;
  counts?: Record<string, number>;
  onOpenTable: (table: string) => void;
  onQuery?: () => void;
}) {
  const [view, setView] = useState<"diagram" | "list">("diagram");
  const [all, setAll] = useState(false);
  const [hover, setHover] = useState<{ node?: string; edge?: string }>({});
  const names = useMemo(() => {
    const every = Object.keys(manifest.tables);
    if (all) return every;
    // Your tables, and whichever built-in ones they're connected to.
    const mine = every.filter((n) => !builtIn(n, manifest.tables[n]!));
    const linked = new Set(mine);
    for (const n of every) for (const r of refsOf(manifest.tables[n]!)) if (linked.has(n) && builtIn(r.target, manifest.tables[r.target]!)) linked.add(r.target);
    for (const n of every) if (builtIn(n, manifest.tables[n]!) && refsOf(manifest.tables[n]!).some((r) => mine.includes(r.target))) linked.add(n);
    return every.filter((n) => linked.has(n));
  }, [manifest, all]);
  const g = useMemo(() => layout(manifest, names), [manifest, names]);
  const hot = (e: Edge) => hover.edge === e.id || hover.node === e.table || hover.node === e.target;
  const hotNode = (n: Node) =>
    hover.node === n.name ||
    g.edges.some((e) => hover.edge === e.id && (e.table === n.name || e.target === n.name)) ||
    (hover.node !== undefined && g.edges.some((e) => hot(e) && (e.table === n.name || e.target === n.name)));
  const dim = hover.node !== undefined || hover.edge !== undefined;

  return (
    <section className="panel relations-view" aria-label="Relationships">
      <header className="table-head">
        <span className="table-icon">
          <Icon name="graph" size={20} />
        </span>
        <div className="table-title">
          <h2>Relationships</h2>
          <p className="muted small">
            {g.nodes.length} tables · {g.edges.length} references, read from the <code>v.id(…)</code> fields in your schema
          </p>
        </div>
        <span className="push" />
        <label className="check-inline">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> All built-in tables
        </label>
        <Segmented
          label="Relationships view"
          value={view}
          options={[
            { value: "diagram", label: "Diagram" },
            { value: "list", label: "List" },
          ]}
          onChange={setView}
        />
      </header>
      {g.edges.length === 0 && (
        <Empty icon="graph">
          No references yet. A field declared with <code>v.id("lists")</code> links its table to <code>lists</code>, and shows up here.
        </Empty>
      )}
      {view === "diagram" && g.edges.length > 0 && (
        <div className="table-body">
          <div className="diagram-wrap">
            <svg
              viewBox={`0 0 ${g.width} ${g.height}`}
              width={g.width}
              height={g.height}
              role="img"
              aria-label={`Diagram of ${g.nodes.length} tables and ${g.edges.length} references. The List view has the same information as text.`}
            >
              <defs>
                <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                  <path d="M0,1 L9,5 L0,9 z" className="arrow" />
                </marker>
                <marker id="arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                  <path d="M0,1 L9,5 L0,9 z" className="arrow hot" />
                </marker>
              </defs>
              {g.edges.map((e) => (
                <g key={e.id} className={`edge ${hot(e) ? "hot" : dim ? "dim" : ""}`} onMouseEnter={() => setHover({ edge: e.id })} onMouseLeave={() => setHover({})}>
                  <path d={e.d} className="edge-hit" />
                  <path d={e.d} className="edge-line" markerEnd={`url(#arrow${hot(e) ? "-hot" : ""})`} strokeDasharray={e.many ? "5 4" : undefined} />
                  {hot(e) && (
                    <text x={e.mx} y={e.my - 7} textAnchor="middle" className="edge-label">
                      {e.id}
                      {e.many ? " (array)" : ""}
                    </text>
                  )}
                </g>
              ))}
              {g.nodes.map((n) => (
                <g key={n.name} className={`erd-node ${n.builtin ? "builtin" : ""} ${hotNode(n) ? "hot" : dim ? "dim" : ""}`} transform={`translate(${n.x},${n.y})`}>
                  <rect width={W} height={n.h} rx={11} className="erd-box" />
                  <g
                    role="link"
                    tabIndex={0}
                    aria-label={`Open ${n.name}`}
                    className="erd-head"
                    onClick={() => onOpenTable(n.name)}
                    onKeyDown={(e) => e.key === "Enter" && onOpenTable(n.name)}
                    onMouseEnter={() => setHover({ node: n.name })}
                    onMouseLeave={() => setHover({})}
                    onFocus={() => setHover({ node: n.name })}
                    onBlur={() => setHover({})}
                  >
                    <path d={`M0,${HEAD} V11 a11,11 0 0 1 11,-11 H${W - 11} a11,11 0 0 1 11,11 V${HEAD} z`} className="erd-head-bg" />
                    <text x={14} y={HEAD / 2 + 5} className="erd-title">
                      {n.name}
                    </text>
                    <text x={W - 14} y={HEAD / 2 + 4} textAnchor="end" className="erd-count">
                      {counts?.[n.name] !== undefined ? `${counts[n.name]!.toLocaleString()}` : ""}
                    </text>
                  </g>
                  {n.rows.map((r, i) => (
                    <g key={r.name} transform={`translate(0,${HEAD + i * ROW})`} className={r.ref ? "erd-row ref" : "erd-row"}>
                      <text x={14} y={ROW / 2 + 4} className="erd-field">
                        {r.name}
                      </text>
                      <text x={W - 12} y={ROW / 2 + 4} textAnchor="end" className="erd-type">
                        {r.type.length > 22 ? `${r.type.slice(0, 21)}…` : r.type}
                      </text>
                    </g>
                  ))}
                  {n.extra > 0 && (
                    <text x={14} y={HEAD + n.rows.length * ROW + ROW / 2 + 4} className="erd-type">
                      +{n.extra} more fields
                    </text>
                  )}
                </g>
              ))}
            </svg>
          </div>
          <p className="muted small">Click a table to open it. Arrows go from a field to the table it points at; dashed ones are arrays of ids. Hover to follow a table's connections.</p>
        </div>
      )}
      {view === "list" && g.edges.length > 0 && (
        <div className="table-body">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Field</th>
                  <th scope="col">Points at</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Look up by</th>
                </tr>
              </thead>
              <tbody>
                {g.edges.map((e) => {
                  const index = indexFor(manifest.tables[e.table]!, e.field);
                  return (
                    <tr key={e.id}>
                      <td>
                        <button className="link" onClick={() => onOpenTable(e.table)}>
                          {e.table}
                        </button>
                        <code className="field-name">.{e.field}</code>
                      </td>
                      <td>
                        <button className="link" onClick={() => onOpenTable(e.target)}>
                          {e.target}
                        </button>
                      </td>
                      <td>
                        <Badge>{e.many ? "many (array)" : "one"}</Badge> {manifest.tables[e.table]!.fields[e.field]!.optional && <Badge>optional</Badge>}
                      </td>
                      <td>{e.many ? <span className="faint">scan only</span> : index ? <code className="id-chip">{index}</code> : <Badge tone="warn">no index</Badge>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {onQuery && (
            <div className="toolbar">
              <Button variant="ghost" onClick={onQuery}>
                <Icon name="functions" size={16} /> Try a join in the function runner
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** For a table's Schema view: what it points at and what points at it. */
export function TableRelations({ table, manifest, onOpenTable }: { table: string; manifest: Manifest; onOpenTable: (table: string) => void }) {
  const info = manifest.tables[table]!;
  const outgoing = refsOf(info);
  const incoming = incomingOf(manifest, table);
  if (!outgoing.length && !incoming.length) return null;
  return (
    <section aria-label="Relations" className="stack schema-section">
      <div className="section-head">
        <h3>Relations</h3>
        <span className="muted small">Declared with v.id(…). Not enforced: deleting a document leaves the ids that pointed at it.</span>
      </div>
      <div className="table-wrap">
        <table className="schema-table">
          <thead>
            <tr>
              <th scope="col">Direction</th>
              <th scope="col">Field</th>
              <th scope="col">Other table</th>
              <th scope="col">Look up by</th>
            </tr>
          </thead>
          <tbody>
            {outgoing.map((r) => (
              <tr key={`out-${r.field}`}>
                <td>
                  <Badge tone="accent">points at</Badge>
                </td>
                <td>
                  <code className="field-name">{r.field}</code> {r.many && <Badge>array</Badge>} {r.optional && <Badge>optional</Badge>}
                </td>
                <td>
                  <button className="link" onClick={() => onOpenTable(r.target)}>
                    {r.target}
                  </button>
                </td>
                <td>
                  <span className="faint">—</span>
                </td>
              </tr>
            ))}
            {incoming.map((r) => (
              <tr key={`in-${r.table}.${r.field}`}>
                <td>
                  <Badge>referenced by</Badge>
                </td>
                <td>
                  <code className="field-name">{r.field}</code> {r.many && <Badge>array</Badge>}
                </td>
                <td>
                  <button className="link" onClick={() => onOpenTable(r.table)}>
                    {r.table}
                  </button>
                </td>
                <td>{r.many ? <span className="faint">scan only</span> : r.index ? <code className="id-chip">{r.index}</code> : <Badge tone="warn">no index</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
