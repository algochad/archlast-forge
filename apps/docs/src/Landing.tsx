import { type CSSProperties, Fragment, type PointerEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Code, CopyButton } from "./Code";
import { Arrow, Mark } from "./icons";
import { Perf } from "./Perf";
import { GITHUB, GROUPS, NPM, type Slug, reading, titleOf } from "./nav";
import { snippets } from "./snippets" with { type: "macro" };

const code = snippets();

const features: [string, string, Slug][] = [
  ["Live queries", "A query's result updates in every open window when the data it read changes. No polling, no refresh code.", "reactivity"],
  ["Typed end to end", "Clients get their types from your functions, and the server checks every argument and every result.", "clients"],
  ["Queries that stay fast", "Indexes, filters, sorting and pagination run as SQL, and development warns about any query that scans a whole table.", "queries"],
  ["Sign-in built in", "Email and password out of the box, social sign-in and more from one file, and sessions every function can read.", "auth"],
  ["File storage", "Uploads straight to S3-compatible storage, or files kept on the server's own disk behind signed links.", "storage"],
  ["Scheduling and crons", "Run a function later or on a schedule. Scheduled mutations run exactly once.", "scheduling"],
  ["HTTP and API docs", "Webhooks and public routes beside your functions, with an OpenAPI document and a docs page, Try it included, generated from them.", "api-docs"],
  ["A dashboard", "Browse and edit data, run functions, read logs, manage users and change settings, from the browser.", "dashboard"],
  ["Tracing and metrics", "Every request timed and traced, with error tracking, SLOs and alerts, kept in your own database.", "observability"],
  ["Backups", "The database and its files on a schedule, to a folder or a bucket, restored from the dashboard or the CLI.", "backups"],
  ["Services that call services", "Forge RPC: typed calls from one backend to another, checked against the service's own generated types.", "forge-rpc"],
  ["One repo, many apps", "A monorepo with the app, its services, and mobile and desktop apps, all sharing generated types.", "monorepo"],
];

const promises = [
  ["Transactions", "Every mutation runs in one. It commits whole or not at all."],
  ["Types from your code", "Change a function and the client's types change with it. Development regenerates them as you save."],
  ["Narrow live queries", "A query wakes only for writes it could have seen, so a busy table doesn't wake everyone."],
  ["Honest retries", "Scheduled mutations run exactly once. Actions run at most once and never retry on their own."],
  ["Room to grow", "Add function processes from the dashboard without a restart, and run several servers on PostgreSQL with Redis between them."],
  ["Your data, your disk", "One deployment per app, on SQLite or PostgreSQL that you run. No control plane, no account to sign up for."],
];

const steps: [string, string, typeof code.schema, Slug][] = [
  ["Describe your data", "A schema with validators gives every document a TypeScript type and rejects bad writes before they reach the database. Indexes make reads narrow, which keeps live queries cheap.", code.schema, "schema"],
  ["Write functions", "Queries read, mutations write inside a transaction, actions talk to the outside world. Your code runs on your server, next to your data.", code.functions, "functions"],
  ["Use them, live", "Call a function from a page. The component shows the result and updates itself whenever it changes, in every window that has it open.", code.component, "clients"],
];

const spec = [
  ["Container", 1, "runs the whole app"],
  ["Databases", 2, "SQLite or PostgreSQL"],
  ["Accounts", 0, "to sign up for: it runs on your servers"],
  ["Docs", reading.length, "pages, with a tutorial"],
] as const;

const Tag = ({ children }: { children: ReactNode }) => <span className="tag">{children}</span>;
const More = ({ to, children }: { to: string; children: ReactNode }) => (
  <Link className="btn link" to={to}>{children} <Arrow /></Link>
);

/** A CSS custom property, for staggering: `--i` delays a word, `--d` delays a reveal. */
const at = (name: string, n: number) => ({ [name]: n }) as CSSProperties;

/** Words that blur into focus one after another, after ReactBits' BlurText. `from` continues the stagger of an earlier run. */
const Words = ({ text, from = 0 }: { text: string; from?: number }) =>
  text.split(" ").map((w, i, all) => (
    <Fragment key={i}>
      <span className="bw" style={at("--i", from + i)}>{w}</span>
      {i < all.length - 1 && " "}
    </Fragment>
  ));

/** A number that counts up once it scrolls into view, after ReactBits' CountUp. */
function Count({ to }: { to: number }) {
  const ref = useRef<HTMLElement>(null);
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [n, setN] = useState(calm ? to : 0);
  useEffect(() => {
    if (calm) return;
    let raf = 0;
    const io = new IntersectionObserver(([e]) => {
      if (!e!.isIntersecting) return;
      io.disconnect();
      const t0 = performance.now();
      const tick = (t: number) => {
        const p = Math.min((t - t0) / 1400, 1);
        setN(Math.round(to * (1 - (1 - p) ** 4)));
        if (p < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    });
    io.observe(ref.current!);
    return () => (io.disconnect(), cancelAnimationFrame(raf));
  }, [to]);
  return <b ref={ref}>{n}</b>;
}

/** Fades `[data-reveal]` elements in as they scroll into view, after ReactBits' AnimatedContent. */
function useReveal() {
  useEffect(() => {
    const io = new IntersectionObserver((entries) => entries.forEach((e) => e.isIntersecting && (e.target.classList.add("in"), io.unobserve(e.target))), { threshold: 0.12 });
    document.querySelectorAll("[data-reveal]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

/** Points a card's spotlight (--mx, --my in the CSS) at the pointer, after ReactBits' SpotlightCard. */
function spot(e: PointerEvent<HTMLElement>) {
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--mx", `${e.clientX - r.left}px`);
  el.style.setProperty("--my", `${e.clientY - r.top}px`);
}

function InstallLine({ id, cmd }: { id: string; cmd: string }) {
  return (
    <div className="install-line">
      <span className="prompt">$</span>
      <code id={id}>{cmd}</code>
      <CopyButton label="Copy command" read={() => cmd} />
    </div>
  );
}

const COMMANDS = [
  ["bun create", "bun create archlast-forge my-app"],
  ["bunx", "bunx create-archlast-forge my-app"],
] as const;

/** "Add note" in window A, and the same note appears in window B. Still for prefers-reduced-motion. */
function Demo() {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const demo = root.current!;
    const [a, b] = demo.querySelectorAll("ul");
    const btn = demo.querySelector("button")!;
    const notes = ["Buy oat milk", "Ship the release", "Call Ada back", "Water the plants", "Review PR #42", "Book flights", "Back up the database", "Write the changelog"];
    const timers = new Set<number>();
    const later = (f: () => void, ms: number) => void timers.add(setTimeout(f, ms) as unknown as number);
    const add = (list: HTMLUListElement, text: string, flash = false) => {
      const li = document.createElement("li");
      li.textContent = text;
      if (flash) li.className = "flash";
      list.prepend(li);
      [...list.children].filter((x) => !x.classList.contains("out")).slice(3).forEach((x) => (x.classList.add("out"), later(() => x.remove(), 300)));
    };
    for (const t of ["Water the plants", "Call Ada back"]) (add(a!, t), add(b!, t));
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let n = 0, timer = 0;
    const step = () => {
      const text = notes[n++ % notes.length]!;
      btn.classList.add("press");
      later(() => btn.classList.remove("press"), 160);
      later(() => add(a!, text), 200);
      later(() => add(b!, text, true), 520);
    };
    const run = () => void (timer ||= setInterval(step, 2800) as unknown as number);
    const stop = () => (clearInterval(timer), (timer = 0));
    const io = new IntersectionObserver(([e]) => (e!.isIntersecting && !document.hidden ? run() : stop()));
    const onVisible = () => (document.hidden ? stop() : run());
    io.observe(demo);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisible);
      timers.forEach(clearTimeout);
    };
  }, []);
  return (
    <div className="demo" ref={root} aria-label="Two browser windows showing the same list updating together">
      <div className="win">
        <div className="win-bar"><span>Window A</span></div>
        <div className="win-body"><button type="button" className="mini-btn" tabIndex={-1}>Add note</button><ul /></div>
      </div>
      <div className="win">
        <div className="win-bar"><span>Window B</span><em className="live-tag">Live</em></div>
        <div className="win-body"><div className="mini-label">Updates by itself</div><ul /></div>
      </div>
    </div>
  );
}

function Footer() {
  const col = (name: string, links: ReactNode) => (
    <div className="foot-col">
      <h4>{name}</h4>
      <div className="foot-links">{links}</div>
    </div>
  );
  const pages = (name: string) => GROUPS.find(([g]) => g === name)![1].map((s) => <Link key={s} to={`/${s}`}>{titleOf(s)}</Link>);
  // Groups stacked into columns of about the same height.
  const stack = (...names: string[]) => <div className="foot-col">{names.map((n) => <Fragment key={n}>{col(n, pages(n))}</Fragment>)}</div>;
  return (
    <footer className="foot">
      <div className="foot-in">
        <div className="foot-brand">
          <Link className="brand" to="/"><Mark /><span>archlast-forge</span></Link>
          <p>A self-hosted reactive backend for TypeScript apps: full-stack apps, backends and the services between them.</p>
          <Link className="btn" to="/getting-started">Get started <Arrow /></Link>
        </div>
        {stack("Start", "Project modes")}
        {stack("Data and functions", "Performance")}
        {stack("Server features", "Clients and guides")}
        {stack("Run", "Reference")}
        {col("Project", [["GitHub", GITHUB], ["Issues", `${GITHUB}/issues`], ["npm", NPM], ["License", `${GITHUB}/blob/master/LICENSE`], ["llms.txt", "/llms.txt"], ["llms-full.txt", "/llms-full.txt"]].map(([t, h]) => <a key={t} href={h}>{t}</a>))}
      </div>
      <div className="foot-bar">
        <span>MIT licensed. One deployment per app, on your own servers.</span>
        <span>Docs built from <a href={`${GITHUB}/tree/master/apps/docs`}>apps/docs</a></span>
      </div>
    </footer>
  );
}

export function Landing() {
  const [cmd, setCmd] = useState<string>(COMMANDS[0][1]);
  const grid = useRef<HTMLDivElement>(null);
  useReveal();
  useEffect(() => {
    document.title = "archlast-forge: the reactive backend you host yourself";
    scrollTo(0, 0);
  }, []);
  return (
    <>
      <main id="content" className="land">
        <section
          className="hero"
          onPointerMove={(e) => {
            const g = grid.current!;
            const r = g.getBoundingClientRect();
            g.style.setProperty("--mx", `${e.clientX - r.left}px`);
            g.style.setProperty("--my", `${e.clientY - r.top}px`);
          }}
          onPointerLeave={() => grid.current!.style.removeProperty("--mx")}
        >
          <div className="hero-grid" ref={grid} aria-hidden="true" />
          <div className="hero-in">
            <div className="hero-copy">
              <Tag>Open source · MIT</Tag>
              <h1>
                <Words text="The reactive backend you" />{" "}
                <span className="hl"><Words text="host yourself" from={4} /></span>.
              </h1>
              <p className="lede">Typed queries and mutations with live results, on SQLite or PostgreSQL. Sign-in, file storage, jobs, a dashboard, tracing and backups are built in. It runs as one container, on your own servers.</p>
              <div className="cta">
                <Link className="btn solid" to="/getting-started">Get started</Link>
                <Link className="btn" to="/introduction">Read the docs</Link>
              </div>
              <div className="install">
                <div className="install-tabs" role="tablist">
                  {COMMANDS.map(([name, c]) => (
                    <button key={name} role="tab" aria-selected={c === cmd} onClick={() => setCmd(c)}>{name}</button>
                  ))}
                </div>
                <InstallLine id="install-cmd" cmd={cmd} />
              </div>
            </div>
            <div className="hero-code">
              <Code {...code.hero} />
              <Demo />
            </div>
          </div>
          <div className="spec">
            {spec.map(([k, v, d]) => (
              <div className="spec-cell" key={k}><span className="label">{k}</span><Count to={v} /><span>{d}</span></div>
            ))}
          </div>
        </section>

        <section className="sec">
          <div className="wrap">
            <div className="sec-head" data-reveal><Tag>What is inside</Tag><h2>Everything a backend needs, in one deploy</h2><p>Your data and functions, sign-in, files and jobs, and the tools to run them in production: one engine, deployed on servers you choose.</p></div>
            <div className="cells">
              {features.map(([title, text, to], i) => (
                <Link className="cell" to={`/${to}`} key={title} onPointerMove={spot} data-reveal style={at("--d", i % 3)}>
                  <span className="label">{String(i + 1).padStart(2, "0")}</span>
                  <h3>{title}</h3>
                  <p>{text}</p>
                  <span className="cell-arrow"><Arrow /></span>
                </Link>
              ))}
            </div>
          </div>
        </section>

        <section className="sec tight">
          <div className="wrap two">
            <div className="sec-head" data-reveal><Tag>What you can rely on</Tag><h2>Boring where it matters</h2><p>The guarantees are written down in the docs, with the places the engine does not promise anything.</p><More to="/limits">Limits and security</More></div>
            <ul className="checks">
              {promises.map(([t, d], i) => (
                <li key={t} data-reveal style={at("--d", i)}><span className="box" aria-hidden="true" /><p><b>{t}.</b> {d}</p></li>
              ))}
            </ul>
          </div>
        </section>

        <section className="sec">
          <div className="wrap">
            <div className="sec-head" data-reveal><Tag>How it works</Tag><h2>From an empty folder to live data</h2><p>Three files. The tutorial builds this out into a notes app with search, sign-in and tests.</p></div>
            <div className="steps">
              {steps.map(([title, text, snippet, to], i) => (
                <div className="step" key={title} data-reveal>
                  <div className="step-text"><span className="label step-n">{String(i + 1).padStart(2, "0")}</span><h3>{title}</h3><p>{text}</p><More to={`/${to}`}>Read more</More></div>
                  <div className="step-code"><Code {...snippet} /></div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="sec">
          <div className="wrap">
            <div className="sec-head" data-reveal><Tag>Built for speed, measured</Tag><h2>Rust where the time goes, TypeScript where you write</h2><p>The HTTP engine, the page renderer and the thread pool are written in Rust and native code, so your app keeps its functions in TypeScript. Every number below was measured on one machine with the same limits for every contender, and the harness is in the repository.</p><More to="/benchmarks">The benchmarks, the machine and the method</More></div>
            <Perf pool={code.pool} />
          </div>
        </section>

        <section className="band">
          <div className="wrap">
            <div className="sec-head" data-reveal><Tag>Two ways to run it</Tag><h2>Pick one when you create the project</h2><p>Both use the same engine, and you can switch later.</p></div>
            <div className="modes">
              <Link className="mode" to="/framework" onPointerMove={spot} data-reveal>
                <h3>Full-stack app</h3>
                <p>Pages rendered on the server, file routes and your backend in one container. A SQLite file is all it needs to start.</p>
                <ul><li>Loaders with data already in the first HTML</li><li>One process in development, with live reload</li><li>Deploy with <code>bun run up</code></li></ul>
                <span className="more">Full-stack apps <Arrow /></span>
              </Link>
              <Link className="mode" to="/backend" onPointerMove={spot} data-reveal style={at("--d", 1)}>
                <h3>Backend only</h3>
                <p>The engine and its services as one stack of containers, for a mobile app, a separate frontend, other services, or no frontend.</p>
                <ul><li>PostgreSQL, Redis and S3 storage included</li><li>HTTPS from a proxy in the same stack</li><li>Typed clients for web, mobile and desktop apps</li></ul>
                <span className="more">Backends <Arrow /></span>
              </Link>
            </div>
          </div>
        </section>

        <section className="closing">
          <div className="wrap">
            <h2 data-reveal>Build something that updates itself.</h2>
            <div className="install" data-reveal style={at("--d", 1)}><InstallLine id="close-cmd" cmd={COMMANDS[0][1]} /></div>
            <div className="cta" data-reveal style={at("--d", 2)}><Link className="btn ink" to="/getting-started">Get started</Link><Link className="btn ink-outline" to="/tutorial">Follow the tutorial</Link></div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
