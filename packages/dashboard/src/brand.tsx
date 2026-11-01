import { useId } from "react";

/** The forge mark: an anvil struck by a spark, in ember. */
export function Logo({ size = 28 }: { size?: number }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="logo">
      <defs>
        <linearGradient id={`${id}-ember`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="var(--ember-deep)" />
          <stop offset="0.55" stopColor="var(--ember)" />
          <stop offset="1" stopColor="var(--spark)" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill="var(--logo-bg)" />
      {/* anvil */}
      <path d="M6 12.5h13.5c0 2.3 1.8 3.8 4.5 3.8v1.6h-4c-1.2 0-1.9.7-1.9 1.8v1.5h2.2v3.3H10.6v-3.3h2.2v-1.5c0-1.1-.7-1.8-1.8-1.8C8.1 17.9 6 15.6 6 12.5z" fill={`url(#${id}-ember)`} />
      {/* sparks */}
      <path d="M22.6 5.2l-1 2.6M26.6 7.4l-2.3 1.5M27.4 11.6h-2.6" stroke="var(--spark)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark">
      <Logo />
      <span>
        archlast <b>forge</b>
      </span>
    </span>
  );
}

const PATHS: Record<string, string> = {
  overview: "M3 13a9 9 0 0 1 18 0M12 13l4-4M5.5 19h13",
  data: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6",
  functions: "M9 4c-2 0-3 1-3 3v2c0 1.2-.8 2-2 2 1.2 0 2 .8 2 2v2c0 2 1 3 3 3M15 4c2 0 3 1 3 3v2c0 1.2.8 2 2 2-1.2 0-2 .8-2 2v2c0 2-1 3-3 3",
  logs: "M4 6h16M4 10h10M4 14h16M4 18h8",
  metrics: "M4 19V5M4 19h16M8 15l3-4 3 2 5-6",
  cache: "M12 3l9 4.5-9 4.5-9-4.5L12 3zM3 12l9 4.5 9-4.5M3 16.5L12 21l9-4.5",
  scheduled: "M12 21a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM12 8v4.5l3 2",
  files: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5",
  users: "M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM20 20v-1.5a3.5 3.5 0 0 0-2.6-3.4M15.5 4.2a3.5 3.5 0 0 1 0 6.6",
  audit: "M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6zM9 12l2 2 4-4",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  monitor: "M3 5h18v11H3zM8 20h8M12 16v4",
  logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
  flame: "M12 22c4 0 7-2.8 7-6.8 0-3.6-2.4-6.1-4.2-8.2-.4 1.9-1.5 3-2.8 3.3.4-3-1-6-3.5-8.3C8.3 6.6 5 9.4 5 15.2 5 19.2 8 22 12 22z",
  bolt: "M13 2L4 14h7l-1 8 9-12h-7z",
  key: "M15 7a4 4 0 1 1-3.9 5H8v3H5v-3H3V9h8.1A4 4 0 0 1 15 7z",
  arrow: "M5 12h14M13 6l6 6-6 6",
  plus: "M12 5v14M5 12h14",
  link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
  graph: "M4 4h6v5H4zM14 15h6v5h-6zM4 15h6v5H4zM7 9v6M10 17.5h4M17 15v-3a2 2 0 0 0-2-2h-5",
  // observability
  requests: "M4 8h13l-3-3M20 16H7l3 3",
  errors: "M12 4l9 16H3zM12 10v4M12 17v.5",
  jobs: "M5 7h14M5 12h14M5 17h8M17 15l3 2-3 2",
  spans: "M3 5h8M7 10h10M5 15h6M12 20h9",
  hotspots: "M12 3v3M12 18v3M3 12h3M18 12h3M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 12h.01",
  map: "M6 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM12 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 6h8M7 8l4 8M17 8l-4 8",
  runtime: "M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4",
  releases: "M3 12V4h8l10 10-8 8zM7.5 7.5h.01",
  slo: "M12 21a9 9 0 1 1 9-9M12 12l5-5M12 16a4 4 0 1 1 4-4",
  alerts: "M6 16v-5a6 6 0 1 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0",
  services: "M4 5h16v6H4zM4 13h16v6H4zM8 8h.01M8 16h.01",
  trace: "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z",
  box: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12L4 7.5M12 12v9",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  "trend-up": "M3 17l6-6 4 4 8-8M15 7h6v6",
  "trend-down": "M3 7l6 6 4-4 8 8M15 17h6v-6",
  minus: "M5 12h14",
  "chevron-up": "M6 15l6-6 6 6",
  "chevron-down": "M6 9l6 6 6-6",
  "chevron-left": "M15 6l-6 6 6 6",
  "chevron-right": "M9 6l6 6-6 6",
  external: "M14 4h6v6M20 4l-9 9M18 14v5H5V6h5",
  check: "M5 12l5 5 9-10",
  x: "M6 6l12 12M18 6L6 18",
  play: "M7 5l12 7-12 7z",
  pause: "M8 5v14M16 5v14",
  copy: "M9 9h11v11H9zM5 15V4h11",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  trash: "M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  edit: "M4 20h4L20 8l-4-4L4 16z",
  menu: "M4 6h16M4 12h16M4 18h16",
  backups: "M4 4h16v4H4zM5 8v11h14V8M10 12h4",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  upload: "M12 20V9M7 14l5-5 5 5M5 4h14",
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`icon ${className ?? ""}`}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** Initials avatar for the signed-in admin. */
export function Avatar({ email }: { email: string }) {
  const initials =
    email === "admin-key"
      ? "AK"
      : email
          .split("@")[0]!
          .split(/[._-]/)
          .map((p) => p[0]?.toUpperCase())
          .join("")
          .slice(0, 2);
  return (
    <span className="avatar" aria-hidden="true">
      {initials}
    </span>
  );
}
