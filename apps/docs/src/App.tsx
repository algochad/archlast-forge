import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, Route, Routes, useLocation } from "react-router";
import { Contrast, GithubIcon, Mark, Menu, SearchIcon } from "./icons";
import { GITHUB } from "./nav";
import { DocPage, NotFound } from "./Doc";
import { Landing } from "./Landing";
import { Search } from "./Search";

const LINKS = [
  ["Docs", "/introduction"],
  ["Tutorial", "/tutorial"],
  ["CLI", "/cli"],
  ["API", "/reference"],
];
const mac = /Mac|iPhone|iPad/.test(navigator.platform);

/** A saved choice wins, otherwise the system's (the CSS handles that while data-theme is unset). */
function toggleTheme() {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
  try {
    localStorage.setItem("theme", root.dataset.theme);
  } catch {}
}

function Chrome() {
  const [menu, setMenu] = useState(false);
  const [searching, setSearching] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => setMenu(false), [pathname]);
  useEffect(() => void document.body.classList.toggle("no-scroll", searching), [searching]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(input|textarea|select)$/i.test(document.activeElement?.tagName ?? "");
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing && !searching)) {
        e.preventDefault();
        setSearching(!searching);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [searching]);

  return (
    <div className={menu ? "menu-open" : undefined}>
      <a className="skip" href="#content">Skip to content</a>
      <header className="top">
        <button className="icon-btn only-narrow" type="button" aria-label="Menu" aria-controls="sidebar" aria-expanded={menu} onClick={() => setMenu(!menu)}>
          <Menu />
        </button>
        <Link className="brand" to="/" aria-label="archlast-forge home">
          <Mark />
          <span>archlast-forge</span>
        </Link>
        <nav className="top-links" aria-label="Main">
          {LINKS.map(([name, to]) => (
            <NavLink key={to} to={to!}>{name}</NavLink>
          ))}
        </nav>
        <span className="grow" />
        <button className="search-btn" type="button" aria-label="Search the docs" onClick={() => setSearching(true)}>
          <SearchIcon />
          <span className="search-label">Search docs</span>
          <kbd className="kbd">{mac ? "⌘ K" : "Ctrl K"}</kbd>
        </button>
        <a className="icon-btn" href={GITHUB} rel="noopener" aria-label="archlast-forge on GitHub, open source"><GithubIcon /></a>
        <button className="icon-btn" type="button" aria-label="Switch light and dark theme" onClick={toggleTheme}><Contrast /></button>
      </header>
      <Outlet context={() => setMenu(false)} />
      <Search open={searching} onClose={() => setSearching(false)} />
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<Chrome />}>
        <Route index element={<Landing />} />
        <Route path=":slug" element={<DocPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
