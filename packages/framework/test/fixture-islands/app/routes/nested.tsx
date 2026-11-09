import { useState } from "react";
import { Counter } from "../_c/counter";

// A route that is an island itself (it has state) and shows another island, `Counter`, in its output: the one island that hydrates has the other inside it.
export default function Nested() {
  const [n, setN] = useState(0);
  return (
    <main>
      <h1 id="title">Nested</h1>
      <button id="outer" onClick={() => setN(n + 1)}>
        outer {n}
      </button>
      <Counter start={5} step={5} />
    </main>
  );
}
