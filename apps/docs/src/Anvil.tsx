import { useEffect, useRef, useState } from "react";

/**
 * Anvil, Forge's thread pool, as a picture: requests arrive at a server, light ones (a ping) and heavy ones (hashing a file). On one thread the heavy
 * request holds everything behind it; with the pool it is handed to a worker and the serving thread keeps answering. The numbers are a model, drawn to
 * show the idea, not measurements (the measured ones are on the benchmarks page).
 */

type Kind = "ping" | "hash";
interface Job { id: number; kind: Kind; arrived: number; started?: number; done?: number; lane: number; waited?: number }

const WORKERS = 3;
const SERVE = { ping: 140, hash: 1200, handoff: 50 };
const ARRIVE = { ping: 520, cycle: 4400, hashes: [600, 1000, 1400] };
const LANES = ["Serving thread", "Worker 1", "Worker 2", "Worker 3"];

interface Sim { t: number; jobs: Job[]; nextId: number; nextPing: number; hashAt: number; queue: Job[]; busyUntil: number; current?: Job; workers: (Job | undefined)[]; waiting: Job[]; lastPing: number; slowest: number }

const fresh = (): Sim => ({ t: 0, jobs: [], nextId: 1, nextPing: 200, hashAt: ARRIVE.hashes[0]!, queue: [], busyUntil: 0, workers: Array(WORKERS).fill(undefined), waiting: [], lastPing: 0, slowest: 0 });

/** Moves the model forward by `dt` ms. */
function advance(s: Sim, dt: number, pooled: boolean) {
  const end = s.t + dt;
  while (s.t < end) {
    s.t = Math.min(end, s.t + 10);
    const now = s.t;
    const arrive = (kind: Kind) => {
      const job: Job = { id: s.nextId++, kind, arrived: now, lane: 0 };
      s.jobs.push(job);
      s.queue.push(job);
    };
    while (now >= s.nextPing) (arrive("ping"), (s.nextPing += ARRIVE.ping));
    // three heavy requests together, then quiet, over and over
    while (now >= s.hashAt) {
      arrive("hash");
      const cycle = Math.floor(s.hashAt / ARRIVE.cycle);
      const i = ARRIVE.hashes.indexOf(s.hashAt - cycle * ARRIVE.cycle);
      s.hashAt = i < ARRIVE.hashes.length - 1 ? cycle * ARRIVE.cycle + ARRIVE.hashes[i + 1]! : (cycle + 1) * ARRIVE.cycle + ARRIVE.hashes[0]!;
    }
    // the serving thread takes the next job when it is free
    if (s.current && now >= s.busyUntil) {
      const job = s.current;
      s.current = undefined;
      if (job.kind === "hash" && pooled) s.waiting.push(job); // handed off: the worker does the rest
      else job.done = now;
      if (job.kind === "ping") {
        s.lastPing = Math.round(now - job.arrived);
        s.slowest = Math.max(s.slowest * 0.97, s.lastPing);
      }
    }
    if (!s.current && s.queue.length) {
      const job = s.queue.shift()!;
      job.started = now;
      s.current = job;
      s.busyUntil = now + (job.kind === "hash" && pooled ? SERVE.handoff : SERVE[job.kind]);
    }
    // workers
    for (let w = 0; w < WORKERS; w++) {
      const running = s.workers[w];
      if (running && now >= (running.done ?? Infinity)) s.workers[w] = undefined;
      if (!s.workers[w] && s.waiting.length) {
        const job = s.waiting.shift()!;
        job.lane = w + 1;
        job.started = now;
        job.done = now + SERVE.hash;
        s.workers[w] = job;
      }
    }
  }
  s.jobs = s.jobs.filter((j) => j.done === undefined || s.t - j.done < 400);
}

const X = { label: 8, queue: 150, slot: 392, out: 540 };
const Y = [38, 108, 154, 200];

export function Anvil() {
  const [pooled, setPooled] = useState(true);
  const [playing, setPlaying] = useState(true);
  const [, frame] = useState(0);
  const sim = useRef<Sim>(fresh());
  const calm = useRef(typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const box = useRef<HTMLDivElement>(null);
  const visible = useRef(true);

  // a new model whenever the mode changes
  useEffect(() => {
    sim.current = fresh();
    advance(sim.current, calm.current ? 4200 : 600, pooled);
    frame((n) => n + 1);
  }, [pooled]);

  useEffect(() => {
    if (calm.current || !playing) return;
    let raf = 0;
    let last = performance.now();
    let drawn = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(t - last, 100);
      last = t;
      if (!visible.current || document.hidden) return;
      advance(sim.current, dt, pooled);
      if (t - drawn > 33) (drawn = t), frame((n) => n + 1);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [pooled, playing]);

  useEffect(() => {
    const io = new IntersectionObserver(([e]) => void (visible.current = e!.isIntersecting));
    io.observe(box.current!);
    return () => io.disconnect();
  }, []);

  const s = sim.current;
  const place = (j: Job): [number, number, number] => {
    // finished: slides out to the right and fades
    if (j.done !== undefined && s.t >= j.done) {
      const p = (s.t - j.done) / 400;
      return [X.slot + p * (X.out - X.slot), Y[j.lane]!, 1 - p];
    }
    if (j.lane > 0 || s.current === j) return [X.slot, Y[j.lane]!, 1];
    const index = s.queue.indexOf(j);
    if (index >= 0) return [X.slot - 44 - index * 30, Y[0]!, 1];
    // handed off and waiting for a free worker
    return [X.slot - 44 - s.waiting.indexOf(j) * 30, Y[1]!, 0.7];
  };

  return (
    <div className="anvil" ref={box}>
      <div className="anvil-bar">
        <div className="seg" role="tablist" aria-label="Thread pool">
          <button role="tab" aria-selected={!pooled} onClick={() => setPooled(false)}>One thread</button>
          <button role="tab" aria-selected={pooled} onClick={() => setPooled(true)}>With Anvil</button>
        </div>
        {!calm.current && (
          <button className="anvil-play" onClick={() => setPlaying((p) => !p)} aria-pressed={!playing}>{playing ? "Pause" : "Play"}</button>
        )}
      </div>
      <svg viewBox="0 0 600 236" role="img" aria-label={pooled ? "Heavy requests run on worker threads while the serving thread keeps answering light ones." : "A heavy request on the serving thread holds up the light requests queued behind it."}>
        {LANES.map((name, i) => (
          <g key={name} opacity={i > 0 && !pooled ? 0.28 : 1}>
            <line x1={X.label} x2={592} y1={Y[i]! + 22} y2={Y[i]! + 22} className="lane" />
            <text x={X.label} y={Y[i]! - 8} className="lane-name">{name}</text>
            <rect x={X.slot - 20} y={Y[i]! - 16} width={40} height={32} className="slot" />
          </g>
        ))}
        {s.jobs.map((j) => {
          const [x, y, o] = place(j);
          return j.kind === "ping" ? (
            <g key={j.id} transform={`translate(${x} ${y})`} opacity={Math.max(0, o)}>
              <circle r={9} className={s.current === j ? "tok ping run" : "tok ping"} />
            </g>
          ) : (
            <g key={j.id} transform={`translate(${x} ${y})`} opacity={Math.max(0, o)}>
              <rect x={-24} y={-10} width={48} height={20} rx={3} className="tok hash" />
              {j.lane > 0 && j.done !== undefined && s.t < j.done && (
                <rect x={-24} y={-10} width={48 * Math.min(1, (s.t - (j.started ?? s.t)) / SERVE.hash)} height={20} rx={3} className="tok fill" />
              )}
              <text y={4} textAnchor="middle" className="tok-text">hash</text>
            </g>
          );
        })}
        <text x={X.queue} y={Y[0]! - 8} className="lane-name">waiting</text>
      </svg>
      <div className="anvil-read">
        <span>last ping answered after <b>{s.lastPing || "…"} ms</b></span>
        <span>{pooled ? "the serving thread is free for the next request" : "pings wait while a hash runs"}</span>
      </div>
    </div>
  );
}
