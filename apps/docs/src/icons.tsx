import type { ReactNode } from "react";

/** Lucide-style outlines, 24px grid. */
const Stroke = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const Arrow = () => (
  <Stroke>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Stroke>
);
export const SearchIcon = () => (
  <Stroke>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </Stroke>
);
export const Menu = () => (
  <Stroke>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </Stroke>
);
export const Contrast = () => (
  <Stroke>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" />
  </Stroke>
);
export const Mark = () => (
  <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
    <rect width="24" height="24" rx="4" fill="#ff5b1f" />
    <path d="M12 5.2 19 19h-3.4L12 11.8 8.4 19H5z" fill="#120a05" />
  </svg>
);
