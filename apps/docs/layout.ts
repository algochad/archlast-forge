// Markup shared by the docs pages and the landing page: icons, the top bar, the search dialog, the page shell.
export const GITHUB = "https://github.com/algochad/archlast-forge";
export const NPM = "https://www.npmjs.com/org/archlast";

export const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const stroke = (d: string) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

/** Lucide-style outlines, 24px grid. */
export const icons = {
  zap: stroke(`<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>`),
  shield: stroke(`<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>`),
  database: stroke(`<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>`),
  layout: stroke(`<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>`),
  clock: stroke(`<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>`),
  upload: stroke(`<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>`),
  globe: stroke(`<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>`),
  terminal: stroke(`<path d="m4 17 6-6-6-6M12 19h8"/>`),
  box: stroke(`<path d="M21 8 12 3 3 8v8l9 5 9-5V8zM3 8l9 5 9-5M12 13v8"/>`),
  code: stroke(`<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>`),
  search: stroke(`<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>`),
  menu: stroke(`<path d="M4 6h16M4 12h16M4 18h16"/>`),
  contrast: stroke(`<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>`),
  arrow: stroke(`<path d="M5 12h14M13 6l6 6-6 6"/>`),
  github: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.76 2.69 1.25 3.34.96.1-.74.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.18-3.08-.12-.29-.51-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.76 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.8 1.18 1.82 1.18 3.08 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z"/></svg>`,
};

export const mark = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><rect width="24" height="24" rx="4" fill="#ff5b1f"/><path d="M12 5.2 19 19h-3.4L12 11.8 8.4 19H5z" fill="#120a05"/></svg>`;
const favicon = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="4" fill="#ff5b1f"/><path d="M12 5.2 19 19h-3.4L12 11.8 8.4 19H5z" fill="#120a05"/></svg>`)}`;

const NAV = [
  ["Docs", "introduction.html"],
  ["Tutorial", "tutorial.html"],
  ["CLI", "cli.html"],
  ["API", "reference.html"],
] as const;

export const topbar = (active = "") => `<header class="top">
  <button class="icon-btn only-narrow" id="menu-btn" type="button" aria-label="Menu" aria-controls="sidebar">${icons.menu}</button>
  <a class="brand" href="index.html" aria-label="archlast-forge home">${mark}<span>archlast-forge</span></a>
  <nav class="top-links" aria-label="Main">${NAV.map(([name, href]) => `<a href="${href}"${href === active ? ' aria-current="page"' : ""}>${name}</a>`).join("")}</nav>
  <span class="grow"></span>
  <button class="search-btn" id="search-open" type="button" aria-label="Search the docs">${icons.search}<span class="search-label">Search docs</span><kbd class="kbd">Ctrl K</kbd></button>
  <a class="icon-btn" href="${GITHUB}" aria-label="GitHub" rel="noopener">${icons.github}</a>
  <button class="icon-btn" id="theme-btn" type="button" aria-label="Switch light and dark theme">${icons.contrast}</button>
</header>`;

export const searchDialog = `<div class="search" id="search" role="dialog" aria-modal="true" aria-label="Search the docs" hidden>
  <div class="search-backdrop" data-close></div>
  <div class="search-panel">
    <div class="search-input">${icons.search}<input id="search-q" type="search" placeholder="Search the docs" autocomplete="off" spellcheck="false" aria-controls="search-results"><kbd class="kbd" data-close>Esc</kbd></div>
    <div class="search-results" id="search-results" role="listbox"></div>
    <div class="search-foot"><span><kbd class="kbd">↑</kbd> <kbd class="kbd">↓</kbd> to move</span><span><kbd class="kbd">Enter</kbd> to open</span></div>
  </div>
</div>`;

/** Sets the theme before first paint, so a saved choice does not flash the other one. */
const themeBoot = `<script>try{var t=localStorage.getItem("theme");if(t)document.documentElement.dataset.theme=t}catch(e){}</script>`;

export function page(opts: { title: string; description: string; body: string; bodyClass?: string; css?: string[]; js?: string[] }) {
  const { title, description, body, bodyClass = "", css = [], js = [] } = opts;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title><meta name="description" content="${escape(description)}"><meta property="og:title" content="${escape(title)}"><meta property="og:description" content="${escape(description)}"><meta name="theme-color" content="#0c0c0d" media="(prefers-color-scheme: dark)"><meta name="theme-color" content="#f6f4ef" media="(prefers-color-scheme: light)"><link rel="preload" as="font" type="font/woff2" href="fonts/geist.woff2" crossorigin><link rel="icon" href="${favicon}"><link rel="stylesheet" href="style.css">${css.map((f) => `<link rel="stylesheet" href="${f}">`).join("")}${themeBoot}</head><body class="${bodyClass}"><a class="skip" href="#content">Skip to content</a>${body}${searchDialog}<script src="site.js" defer></script>${js.map((f) => `<script src="${f}" defer></script>`).join("")}</body></html>`;
}
