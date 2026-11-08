export function Bar({ label, pct, tone = "ok", wide }: { label: string; pct: number; tone?: string | null; wide?: number | string | null }) {
  return (
    <div className={`bar ${tone}`} data-tone={tone} style={{ width: `${pct}%`, height: 4 * 2, opacity: 0.5, color: "red", marginTop: pct / 4, zIndex: pct * 2, maxWidth: wide as string, flexGrow: wide as number }}>
      {label}
      {wide == null ? " (no width)" : tone === undefined ? "?" : ""}
    </div>
  );
}
