// `Link` and `NavLink` for pages: React Router's, with a shortcut on the server. React Router works out each link's address through the route context (resolving the
// path against the matches, normalizing it), which is a few percent of rendering a page with a menu and rows that link; for a plain address ("/products") the answer is the
// address itself, and the markup is the same. Anything the shortcut does not cover, and everything in the browser (where a click has to navigate), is React Router's.
import type { CSSProperties } from "react";
import { Link as RouterLink, NavLink as RouterNavLink, useLocation, type LinkProps, type NavLinkProps } from "react-router";

const onServer = typeof document === "undefined";

/** Props that change what a link does or says beyond an anchor with an address. */
const OTHER = ["replace", "state", "reloadDocument", "preventScrollReset", "relative", "viewTransition", "discover", "prefetch", "target", "download", "caseSensitive"];

/** An absolute path React Router would leave as it is: no empty or dotted segments, no escapes, no trailing slash (React Router compares those differently). */
const plain = (to: unknown): to is string => typeof to === "string" && /^\/[^?#%\\]*$/.test(to) && (to === "/" || !to.endsWith("/")) && !to.includes("//") && !/\/\.{1,2}(\/|$)/.test(to);

const simple = (props: object) => !OTHER.some((k) => k in props);

export function Link(props: LinkProps) {
  if (onServer && plain(props.to) && simple(props)) {
    const { to, ref: _ref, ...rest } = props as LinkProps & { ref?: unknown };
    return <a {...rest} href={to as string} data-discover="true" />;
  }
  return <RouterLink {...props} />;
}

export function NavLink(props: NavLinkProps) {
  const { pathname } = useLocation();
  if (onServer && plain(props.to) && simple(props) && typeof props.style !== "function" && typeof props.children !== "function") {
    const { to: _to, end, className, style, ref: _ref, ...rest } = props as NavLinkProps & { ref?: unknown };
    const to = props.to as string;
    // React Router's rule: active on the path itself, and (unless `end`) on anything below it; paths compare without case.
    const target = to.toLowerCase();
    const here = pathname.toLowerCase();
    const active = here === target || (!end && here.startsWith(target) && here.charAt(target.length) === "/");
    const given = typeof className === "function" ? className({ isActive: active, isPending: false, isTransitioning: false }) : [className, active ? "active" : null].filter(Boolean).join(" ");
    return <a {...(rest as object)} href={to} data-discover="true" className={given} style={style as CSSProperties | undefined} aria-current={active ? (rest["aria-current"] ?? "page") : undefined} />;
  }
  return <RouterNavLink {...props} />;
}
