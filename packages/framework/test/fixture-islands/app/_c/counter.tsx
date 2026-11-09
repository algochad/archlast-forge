import { useState } from "react";

export function Counter({ start, step }: { start: number; step: number }) {
  const [n, setN] = useState(start);
  return (
    <button id="counter" onClick={() => setN(n + step)}>
      count {n}
    </button>
  );
}
