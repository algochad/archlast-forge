export function Bar({ label, pct, tone = "ok" }: { label: string; pct: number; tone?: string }) {
  return (
    <div className={`bar ${tone}`} style={{ width: `${pct}%`, height: 4 * 2, opacity: 0.5, color: "red", marginTop: pct / 4, zIndex: pct * 2 }}>
      {label}
    </div>
  );
}
