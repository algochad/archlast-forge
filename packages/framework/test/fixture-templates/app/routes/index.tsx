import { Link, useViewer } from "@archlast/forge-framework";
import { Badge, Card } from "../_c/card";

const FEATURES = [
  ["Fast <pages>", "They're printed by the engine & served"],
  ["Typed", 'Say "hello" to types'],
];
const LIMIT = 9;

export default function Home() {
  const viewer = useViewer();
  return (
    <main id="main">
      <title>Home & away</title>
      <meta name="description" content="A page <with> odd & characters" />
      <h1>{viewer ? `Welcome back, ${viewer.name}` : "Welcome"}</h1>
      <p>
        {1 + 2} then {"a" + 1} then {LIMIT > 1 ? "big" : "small"} and {FEATURES.length} features
      </p>
      <ul>
        {FEATURES.map(([title, text], i) => (
          <li key={i} className={i === 0 ? "first" : undefined} data-index={i}>
            <strong>{title}</strong> {text}
          </li>
        ))}
      </ul>
      <Card title="Plain">
        <p>Inside a card</p>
        <Badge label="Seen" count={3} />
        <Badge label="Many" count={12} />
      </Card>
      <Card title="Tinted" tone="warm" />
      {viewer && <p id="member">Member since never</p>}
      {viewer ? <Link to="/items">Your items</Link> : <Link to="/items" className="cta">Browse items</Link>}
      <button disabled aria-pressed hidden={false} type="button">
        Disabled
      </button>
      <img src="/x.png" alt="" width={32} height={0} />
      <input type="text" name="q" placeholder={'say "hi"'} maxLength={20} />
      <br />
      {null}
      {false}
      {undefined}
      0 items {0}
    </main>
  );
}
