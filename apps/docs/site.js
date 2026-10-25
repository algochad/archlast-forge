// Behavior for the docs: theme, copy buttons, search, the mobile menu and the "On this page" highlight. No dependencies.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const root = document.documentElement;

  // Theme: a saved choice wins, otherwise the system's (the CSS handles that when data-theme is unset).
  $("#theme-btn")?.addEventListener("click", () => {
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("theme", root.dataset.theme); } catch {}
  });

  // Copy buttons: code blocks, and the install command on the landing page.
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
    const t = document.createElement("textarea");
    t.value = text; t.style.position = "fixed"; t.style.opacity = "0";
    document.body.append(t); t.select();
    try { return document.execCommand("copy"); } finally { t.remove(); }
  }
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest?.(".copy");
    if (!btn) return;
    const from = btn.dataset.copyFrom;
    const text = from ? document.getElementById(from).textContent : btn.closest(".code")?.querySelector("pre")?.textContent ?? "";
    if (await copy(text)) {
      btn.textContent = "Copied";
      btn.classList.add("done");
      setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("done"); }, 1600);
    }
  });

  // Install command tabs.
  $$("[data-install] [data-cmd]").forEach((tab) => tab.addEventListener("click", () => {
    $$("[data-install] [data-cmd]").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
    $("#install-cmd").textContent = tab.dataset.cmd;
  }));

  // Mobile menu.
  const closeMenu = () => document.body.classList.remove("menu-open");
  $("#menu-btn")?.addEventListener("click", () => document.body.classList.toggle("menu-open"));
  $("[data-close-menu]")?.addEventListener("click", closeMenu);
  $("#sidebar")?.addEventListener("click", (e) => { if (e.target.closest("a")) closeMenu(); });

  // Keep the current page in view in a long sidebar.
  const side = $("#sidebar"), here = side && $("a[aria-current]", side);
  if (side && here) side.scrollTop = Math.max(0, here.offsetTop - side.clientHeight / 3);

  // "On this page": mark the section being read.
  const links = new Map($$(".toc a").map((a) => [a.getAttribute("href").slice(1), a]));
  if (links.size && "IntersectionObserver" in window) {
    const visible = new Set();
    const heads = $$(".prose h2[id], .prose h3[id]");
    const mark = () => {
      const current = heads.find((h) => visible.has(h.id)) ?? [...heads].reverse().find((h) => h.getBoundingClientRect().top < 100);
      links.forEach((a, id) => a.toggleAttribute("aria-current", id === current?.id));
    };
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) en.isIntersecting ? visible.add(en.target.id) : visible.delete(en.target.id);
      mark();
    }, { rootMargin: "-70px 0px -65% 0px" });
    heads.forEach((h) => io.observe(h));
  }

  // Search: loads search.json on first use. Every word must match; headings count for more than body text.
  const dlg = $("#search"), input = $("#search-q"), out = $("#search-results");
  let index = null, loading = null, active = 0, hits = [];
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  $$(".search-btn .kbd").forEach((k) => (k.textContent = mac ? "⌘ K" : "Ctrl K"));

  const quick = [["Getting started", "getting-started.html"], ["Tutorial: a notes app", "tutorial.html"], ["CLI reference", "cli.html"], ["Configuration", "configuration.html"], ["Troubleshooting", "troubleshooting.html"]];
  function render() {
    if (!input.value.trim()) {
      hits = quick.map(([t, u]) => ({ title: t, sub: "", url: u, snip: "" }));
    }
    out.innerHTML = hits.length
      ? hits.map((h, i) => `<a role="option" href="${h.url}" class="hit${i === active ? " on" : ""}" aria-selected="${i === active}"><span class="hit-title">${h.title}${h.sub ? `<span class="hit-sub">${h.sub}</span>` : ""}</span>${h.snip ? `<span class="hit-snip">${h.snip}</span>` : ""}</a>`).join("")
      : `<div class="empty">No results for “${esc(input.value)}”.</div>`;
    out.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  }
  function find(q) {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length || !index) { hits = []; return; }
    const scored = [];
    for (const [page, head, url, text] of index) {
      const h = head.toLowerCase(), p = page.toLowerCase(), x = text.toLowerCase();
      let score = 0;
      for (const t of terms) {
        const inHead = h.includes(t), inPage = p.includes(t), n = x.split(t).length - 1;
        if (!inHead && !inPage && !n) { score = -1; break; }
        score += (inHead ? 10 : 0) + (inPage ? 3 : 0) + Math.min(n, 5);
      }
      if (score > 0) scored.push({ score, page, head, url, text });
    }
    scored.sort((a, b) => b.score - a.score);
    hits = scored.slice(0, 10).map(({ page, head, url, text }) => {
      const at = Math.max(0, text.toLowerCase().indexOf(terms.find((t) => text.toLowerCase().includes(t)) ?? "\0"));
      let snip = esc(text.slice(Math.max(0, at - 40), at + 110));
      for (const t of terms) snip = snip.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"), "<mark>$1</mark>");
      return { title: esc(head), sub: head === page ? "" : esc(page), url, snip: text ? `${at > 40 ? "…" : ""}${snip}…` : "" };
    });
  }
  const open = async () => {
    dlg.hidden = false; document.body.classList.add("no-scroll"); input.focus(); input.select(); active = 0; render();
    loading ??= fetch("search.json").then((r) => r.json()).then((j) => { index = j; find(input.value); render(); }).catch(() => { out.innerHTML = '<div class="empty">Search is not available here.</div>'; });
  };
  const close = () => { dlg.hidden = true; document.body.classList.remove("no-scroll"); };
  $("#search-open")?.addEventListener("click", open);
  dlg?.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) close(); else if (e.target.closest("a.hit")) close(); });
  input?.addEventListener("input", () => { active = 0; find(input.value); render(); });
  document.addEventListener("keydown", (e) => {
    const typing = /^(input|textarea|select)$/i.test(document.activeElement?.tagName ?? "");
    if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing && dlg?.hidden)) { e.preventDefault(); dlg?.hidden ? open() : close(); return; }
    if (!dlg || dlg.hidden) return;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); active = (active + (e.key === "ArrowDown" ? 1 : -1) + hits.length) % Math.max(hits.length, 1); render(); }
    else if (e.key === "Enter" && hits[active]) { e.preventDefault(); location.href = hits[active].url; }
  });
})();
