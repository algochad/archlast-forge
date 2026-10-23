import { useRef, type KeyboardEvent, type ReactNode } from "react";

// comment | string | number | keyword | what the editor puts in scope | a call
const TOKEN =
  /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\[\s\S])*`?)|\b(\d+(?:\.\d+)?)\b|\b(export|default|const|let|var|async|await|function|return|if|else|for|of|in|while|throw|new|try|catch|finally|typeof|true|false|null|undefined)\b|\b(query|mutation|v|ForgeError|ctx)\b|([A-Za-z_$][\w$]*)(?=\()/g;
const CLASSES = ["", "c", "s", "n", "k", "b", "f"];

/** TypeScript-ish source as spans; good enough to read a query, not a parser. */
export function highlight(code: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of code.matchAll(TOKEN)) {
    if (m.index > last) out.push(code.slice(last, m.index));
    const group = m.findIndex((g, i) => i > 0 && g !== undefined);
    out.push(
      <span key={m.index} className={`tok-${CLASSES[group]}`}>
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  out.push(code.slice(last) + "\n"); // the trailing newline keeps the last empty line's height
  return out;
}

const INDENT = "  ";

/**
 * A plain textarea with a highlighted copy behind it. Tab indents, Enter keeps the indentation,
 * Cmd/Ctrl+Enter runs, Escape leaves the editor so Tab can move on.
 */
export function CodeEditor({
  id,
  value,
  onChange,
  onRun,
  minLines = 12,
  maxLines = 26,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  onRun?: () => void;
  minLines?: number;
  maxLines?: number;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const hl = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const lines = value.split("\n").length;

  const edit = (start: number, end: number, text: string, caret = start + text.length) => {
    const el = area.current!;
    el.setRangeText(text, start, end, "end");
    el.setSelectionRange(caret, caret);
    onChange(el.value);
  };

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget;
    const { selectionStart: a, selectionEnd: b, value: text } = el;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onRun?.();
    } else if (e.key === "Escape") {
      el.blur();
    } else if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      edit(a, b, INDENT);
    } else if (e.key === "Tab") {
      e.preventDefault(); // outdent the current line
      const from = text.lastIndexOf("\n", a - 1) + 1;
      const lead = /^ {1,2}/.exec(text.slice(from))?.[0].length ?? 0;
      if (lead) {
        el.setRangeText("", from, from + lead);
        el.setSelectionRange(Math.max(from, a - lead), Math.max(from, b - lead));
        onChange(el.value);
      }
    } else if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      const from = text.lastIndexOf("\n", a - 1) + 1;
      const indent = /^[ \t]*/.exec(text.slice(from, a))![0];
      const opens = /[{(\[]$/.test(text.slice(0, a).trimEnd()) && text.slice(from, a).trim() !== "";
      const closes = /^[ \t]*[})\]]/.test(text.slice(b));
      // Between a pair of brackets, open a blank indented line and keep the closer on its own line.
      if (opens && closes) edit(a, b, `\n${indent}${INDENT}\n${indent}`, a + 1 + indent.length + INDENT.length);
      else edit(a, b, `\n${indent}${opens ? INDENT : ""}`);
    }
  }

  const rows = Math.min(maxLines, Math.max(minLines, lines));
  return (
    <div className="code-editor" style={{ ["--rows" as string]: rows }}>
      <div className="gutter" ref={gutter} aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <span key={i}>{i + 1}</span>
        ))}
      </div>
      <div className="code-area">
        <pre className="hl" ref={hl} aria-hidden="true">
          {highlight(value)}
        </pre>
        <textarea
          ref={area}
          id={id}
          value={value}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          rows={rows}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onScroll={(e) => {
            const { scrollTop, scrollLeft } = e.currentTarget;
            if (hl.current) ((hl.current.scrollTop = scrollTop), (hl.current.scrollLeft = scrollLeft));
            if (gutter.current) gutter.current.scrollTop = scrollTop;
          }}
        />
      </div>
    </div>
  );
}
