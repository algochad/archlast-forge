// Landing page motion: dot grid, pointer effects, the live demo, scroll reveal and count-up. Everything is skipped for prefers-reduced-motion.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Scroll reveal
  const reveal = $$("[data-reveal]");
  if (calm || !("IntersectionObserver" in window)) reveal.forEach((el) => el.classList.add("in"));
  else {
    const io = new IntersectionObserver((entries) => entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
    reveal.forEach((el) => io.observe(el));
  }

  // Count-up for the stats
  $$("[data-count]").forEach((el) => {
    const to = Number(el.dataset.count);
    if (calm || !to || !("IntersectionObserver" in window)) return;
    el.textContent = "0";
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      const t0 = performance.now(), dur = 1100;
      const tick = (t) => { const k = Math.min(1, (t - t0) / dur); el.textContent = String(Math.round(to * (1 - Math.pow(1 - k, 3)))); if (k < 1) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    }, { threshold: 0.6 });
    io.observe(el);
  });

  // Spotlight cards follow the pointer
  $$(".spot").forEach((el) => el.addEventListener("pointermove", (e) => {
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  }));

  // Hero: tilt the code cards a little toward the pointer
  const hero = $("[data-hero]"), tilt = $("[data-tilt]");
  if (hero && tilt && !calm) {
    hero.addEventListener("pointermove", (e) => {
      const r = hero.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      tilt.style.setProperty("--ry", `${(x * 5).toFixed(2)}deg`);
      tilt.style.setProperty("--rx", `${(-y * 4).toFixed(2)}deg`);
    });
    hero.addEventListener("pointerleave", () => { tilt.style.setProperty("--rx", "0deg"); tilt.style.setProperty("--ry", "0deg"); });
  }

  // Dot grid: dots near the pointer grow and take the accent color
  const canvas = $(".dots", hero ?? document);
  if (canvas && hero) {
    const ctx = canvas.getContext("2d");
    const probe = document.createElement("i");
    probe.style.display = "none"; hero.append(probe);
    const colors = () => {
      probe.style.color = "var(--border-strong)"; const dim = getComputedStyle(probe).color;
      probe.style.color = "var(--accent)"; const hot = getComputedStyle(probe).color;
      return [dim, hot];
    };
    const GAP = 30, REACH = 150;
    let w = 0, h = 0, dpr = 1, mx = -999, my = -999, raf = 0, [dim, hot] = colors();
    const size = () => {
      dpr = Math.min(devicePixelRatio || 1, 2);
      w = hero.clientWidth; h = hero.clientHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    };
    const draw = () => {
      raf = 0;
      ctx.clearRect(0, 0, w, h);
      for (let y = GAP / 2; y < h; y += GAP) for (let x = GAP / 2; x < w; x += GAP) {
        const d = Math.hypot(x - mx, y - my), k = d < REACH ? 1 - d / REACH : 0;
        ctx.beginPath();
        ctx.arc(x, y, 1.1 + k * 2.4, 0, Math.PI * 2);
        ctx.fillStyle = k > 0.05 ? hot : dim;
        ctx.globalAlpha = k > 0.05 ? 0.35 + k * 0.65 : 0.7;
        ctx.fill();
      }
    };
    const queue = () => { raf ||= requestAnimationFrame(draw); };
    new ResizeObserver(size).observe(hero);
    if (!calm) {
      hero.addEventListener("pointermove", (e) => { const r = hero.getBoundingClientRect(); mx = e.clientX - r.left; my = e.clientY - r.top; queue(); });
      hero.addEventListener("pointerleave", () => { mx = my = -999; queue(); });
    }
    // Re-read the colors when the theme changes.
    new MutationObserver(() => { [dim, hot] = colors(); queue(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { [dim, hot] = colors(); queue(); });
  }

  // Live demo: "Add note" in window A, and the same note appears in window B
  const demo = $("[data-demo]");
  if (demo) {
    const [a, b] = $$("[data-list]", demo);
    const btn = $("[data-add]", demo);
    const notes = ["Buy oat milk", "Ship the release", "Call Ada back", "Water the plants", "Review PR #42", "Book flights", "Back up the database", "Write the changelog"];
    let n = 0;
    const add = (list, text, flash) => {
      const li = document.createElement("li");
      li.textContent = text;
      if (flash) li.className = "flash";
      list.prepend(li);
      [...list.children].filter((x) => !x.classList.contains("out")).slice(3).forEach((x) => { x.classList.add("out"); setTimeout(() => x.remove(), 300); });
    };
    for (const t of ["Water the plants", "Call Ada back"]) { add(a, t); add(b, t); }
    if (!calm) {
      const step = () => {
        const text = notes[n++ % notes.length];
        btn.classList.add("press");
        setTimeout(() => btn.classList.remove("press"), 160);
        setTimeout(() => add(a, text), 200);
        setTimeout(() => add(b, text, true), 520);
      };
      let timer = 0;
      const run = () => { if (!timer) timer = setInterval(step, 2800); };
      const stop = () => { clearInterval(timer); timer = 0; };
      if ("IntersectionObserver" in window) new IntersectionObserver(([e]) => (e.isIntersecting && !document.hidden ? run() : stop())).observe(demo);
      document.addEventListener("visibilitychange", () => (document.hidden ? stop() : run()));
    }
  }
})();
