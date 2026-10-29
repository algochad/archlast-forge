// Landing page: the live demo ("Add note" in window A, the same note appears in window B). Skipped for prefers-reduced-motion.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;

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
