import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { SearchIcon } from "./icons";

/** [page, heading, url, text], from search.json. */
type Entry = [string, string, string, string];
type Hit = { title: string; sub: string; url: string; text: string };

const QUICK: Hit[] = [
  ["Getting started", "/getting-started"],
  ["Tutorial: a notes app", "/tutorial"],
  ["CLI reference", "/cli"],
  ["Configuration", "/configuration"],
  ["Troubleshooting", "/troubleshooting"],
].map(([title, url]) => ({ title: title!, sub: "", url: url!, text: "" }));

const words = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);

/** Every word must match; headings count for more than body text. */
function find(terms: string[], index: Entry[]): Hit[] {
  const scored: { score: number; hit: Hit }[] = [];
  for (const [page, head, url, text] of index) {
    const h = head.toLowerCase(), p = page.toLowerCase(), x = text.toLowerCase();
    let score = 0;
    for (const t of terms) {
      const inHead = h.includes(t), inPage = p.includes(t), n = x.split(t).length - 1;
      if (!inHead && !inPage && !n) {
        score = -1;
        break;
      }
      score += (inHead ? 10 : 0) + (inPage ? 3 : 0) + Math.min(n, 5);
    }
    if (score > 0) scored.push({ score, hit: { title: head, sub: head === page ? "" : page, url, text } });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 10).map((s) => s.hit);
}

function Snippet({ text, terms }: { text: string; terms: string[] }) {
  const lower = text.toLowerCase();
  const at = Math.max(0, lower.indexOf(terms.find((t) => lower.includes(t)) ?? "\0"));
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "i");
  return (
    <span className="hit-snip">
      {at > 40 && "…"}
      {text.slice(Math.max(0, at - 40), at + 110).split(re).map((s, i) => (i % 2 ? <mark key={i}>{s}</mark> : s))}…
    </span>
  );
}

export function Search({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [index, setIndex] = useState<Entry[] | "failed">();
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const terms = words(q);
  const hits = useMemo(() => (terms.length ? (Array.isArray(index) ? find(terms, index) : []) : QUICK), [q, index]);

  useEffect(() => {
    if (!open) return;
    input.current?.select();
    setActive(0);
    if (!index) fetch("/search.json").then((r) => r.json()).then(setIndex, () => setIndex("failed"));
  }, [open]);
  useEffect(() => void results.current?.querySelector(".on")?.scrollIntoView({ block: "nearest" }), [active, hits]);

  if (!open) return null;
  const go = (url: string) => (navigate(url), onClose());
  return (
    <div
      className="search"
      role="dialog"
      aria-modal="true"
      aria-label="Search the docs"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          setActive((active + (e.key === "ArrowDown" ? 1 : -1) + hits.length) % Math.max(hits.length, 1));
        } else if (e.key === "Enter" && hits[active]) {
          e.preventDefault();
          go(hits[active].url);
        }
      }}
    >
      <div className="search-backdrop" onClick={onClose} />
      <div className="search-panel">
        <div className="search-input">
          <SearchIcon />
          <input ref={input} autoFocus type="search" placeholder="Search the docs" autoComplete="off" spellCheck={false} aria-controls="search-results" value={q} onChange={(e) => (setQ(e.target.value), setActive(0))} />
          <kbd className="kbd" onClick={onClose}>Esc</kbd>
        </div>
        <div className="search-results" id="search-results" role="listbox" ref={results}>
          {hits.length ? (
            hits.map((h, i) => (
              <Link key={h.url} to={h.url} role="option" className={`hit${i === active ? " on" : ""}`} aria-selected={i === active} onClick={onClose}>
                <span className="hit-title">
                  {h.title}
                  {h.sub && <span className="hit-sub">{h.sub}</span>}
                </span>
                {h.text && <Snippet text={h.text} terms={terms} />}
              </Link>
            ))
          ) : (
            <div className="empty">{index === "failed" ? "Search is not available here." : <>No results for “{q}”.</>}</div>
          )}
        </div>
        <div className="search-foot">
          <span><kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> to move</span>
          <span><kbd className="kbd">Enter</kbd> to open</span>
        </div>
      </div>
    </div>
  );
}
