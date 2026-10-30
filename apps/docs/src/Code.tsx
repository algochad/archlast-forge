import { useRef, useState } from "react";

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  const t = document.createElement("textarea");
  t.value = text;
  t.style.position = "fixed";
  t.style.opacity = "0";
  document.body.append(t);
  t.select();
  try {
    return document.execCommand("copy");
  } finally {
    t.remove();
  }
}

export function CopyButton({ read, label }: { read: () => string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={`copy${done ? " done" : ""}`}
      aria-label={label}
      onClick={async () => {
        if (!(await copyText(read()))) return;
        setDone(true);
        setTimeout(() => setDone(false), 1600);
      }}
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

/** A code block. `html` is Shiki's output, made at build time (see highlight.ts). */
export function Code({ html, label }: { html: string; label: string }) {
  const body = useRef<HTMLDivElement>(null);
  return (
    <div className={`code${label ? " titled" : ""}`}>
      <div className="code-head">
        {label && <span className="code-title">{label}</span>}
        <CopyButton label="Copy code" read={() => body.current?.textContent ?? ""} />
      </div>
      <div ref={body} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
