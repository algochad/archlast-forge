import { useState } from "react";

export default function Live() {
  const [n, setN] = useState(0);
  return (
    <main>
      <h1 id="title">Live</h1>
      <button id="inc" onClick={() => setN(n + 1)}>
        n = {n}
      </button>
    </main>
  );
}
