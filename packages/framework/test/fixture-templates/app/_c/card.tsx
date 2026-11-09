import type { ReactNode } from "react";

export function Card({ title, tone, children }: { title: string; tone?: string; children?: ReactNode }) {
  return (
    <section className={`card ${tone ?? "plain"}`} data-tone={tone} aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function Badge({ label, count }: { label: string; count: number }) {
  return (
    <span className="badge">
      {label}: {count}
      {count > 9 && <b> (many)</b>}
    </span>
  );
}
