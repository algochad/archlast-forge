import { Link, useViewer } from "@archlast/forge-framework";

export default function Home() {
  const viewer = useViewer();
  return (
    <main className="container hero">
      <title>__NAME__</title>
      <p className="eyebrow">archlast-forge</p>
      <h1>Realtime. Full-stack. One deploy.</h1>
      <p className="lead">
        Server-rendered React, a typed backend and live queries in a single container. Edit <code>app/routes/index.tsx</code> and save: the page reloads by itself.
      </p>
      <div className="actions">
        {viewer ? (
          <Link className="btn primary" to="/chat">Open the chat</Link>
        ) : (
          <Link className="btn primary" to="/sign-in">Get started</Link>
        )}
        <a className="btn" href="https://github.com/algochad/archlast-forge">Read the docs</a>
      </div>
      <ul className="features">
        <li className="card">
          <h3>Rendered on the server</h3>
          <p>Every page arrives as HTML with its data already in it, then the browser takes over without a flicker.</p>
        </li>
        <li className="card">
          <h3>Live by default</h3>
          <p>A query in a component stays current. Open the chat in two windows and watch both update.</p>
        </li>
        <li className="card">
          <h3>One container</h3>
          <p>Pages, API, auth, files and the dashboard ship together. <code>archlast-forge up</code> starts the lot.</p>
        </li>
      </ul>
    </main>
  );
}
