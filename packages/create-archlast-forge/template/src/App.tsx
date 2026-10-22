import { useAuth, useMutation, usePaginatedQuery, useSession } from "@archlast-forge/react";
import { useState, type FormEvent } from "react";
import { api } from "../convex/_generated/api";

export default function App() {
  const session = useSession();
  if (session.isPending) return <p>Loading…</p>;
  return session.data ? <Chat name={session.data.user.name} /> : <SignIn />;
}

function SignIn() {
  const auth = useAuth();
  const [error, setError] = useState<string>();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email"));
    const password = String(f.get("password"));
    const res = (await auth.signIn.email({ email, password })).error ? await auth.signUp.email({ email, password, name: email.split("@")[0]! }) : undefined;
    setError(res?.error?.message);
  }
  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 8, maxWidth: 320, margin: "10vh auto" }}>
      <h1>__NAME__</h1>
      <input name="email" type="email" placeholder="Email" aria-label="Email" required />
      <input name="password" type="password" placeholder="Password (8+ characters)" aria-label="Password" minLength={8} required />
      <button>Sign in or sign up</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

function Chat({ name }: { name: string }) {
  const { results, status, loadMore } = usePaginatedQuery(api.messages.list, {}, { initialNumItems: 20 });
  const send = useMutation(api.messages.send);
  const [body, setBody] = useState("");
  return (
    <main style={{ maxWidth: 600, margin: "2rem auto", fontFamily: "system-ui" }}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await send({ body });
          setBody("");
        }}
      >
        <input value={body} onChange={(e) => setBody(e.target.value)} placeholder={`Message as ${name}`} aria-label="Message" />
        <button>Send</button>
      </form>
      <ul>
        {results.map((m) => (
          <li key={m._id}>
            <strong>{m.authorName}</strong>: {m.body}
          </li>
        ))}
      </ul>
      {status === "CanLoadMore" && <button onClick={() => loadMore(20)}>Load more</button>}
    </main>
  );
}
