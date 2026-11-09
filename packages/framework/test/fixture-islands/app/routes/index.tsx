import { Counter } from "../_c/counter";

export default function Home() {
  return (
    <main>
      <h1 id="title">Home</h1>
      <p id="static">Nothing here needs the browser.</p>
      <Counter start={1} step={2} />
    </main>
  );
}
