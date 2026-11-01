import { redirect, useTimeZone, useViewer, type LoaderArgs } from "@archlast/forge-framework";
import { ForgeError, useMutation, usePaginatedQuery } from "@archlast/forge-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api } from "../../forge/_generated/api";

const PAGE = 30;

// Runs on the server for the first load and in the browser for later visits. The messages it fetches are kept in the live cache,
// so the list below has its data on first render and then stays current.
export const loader = async ({ ctx }: LoaderArgs) => {
  if (!(await ctx.viewer())) throw redirect("/sign-in");
  await ctx.query(api.messages.list, { paginationOpts: { numItems: PAGE, cursor: null } });
  return null;
};

export default function Chat() {
  const viewer = useViewer();
  // Times are formatted in the visitor's zone: the server renders in the one the browser last told it, and the browser starts from the same, so the page hydrates cleanly.
  const timeZone = useTimeZone();
  const clock = useMemo(() => new Intl.DateTimeFormat("en-US", { timeStyle: "short", timeZone }), [timeZone]);
  const { results, status, loadMore } = usePaginatedQuery(api.messages.list, {}, { initialNumItems: PAGE });
  const send = useMutation(api.messages.send);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string>();
  const end = useRef<HTMLLIElement>(null);
  const messages = [...results].reverse(); // the query is newest first; a chat reads oldest first

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" }); // not returned: in current browsers it returns a Promise, which an effect must not
  }, [messages.length]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setError(undefined);
    try {
      await send({ body });
      setBody("");
    } catch (err) {
      setError(err instanceof ForgeError || err instanceof Error ? err.message : "Couldn't send that");
    }
  }

  return (
    <main className="container">
      <title>Chat</title>
      <h1>Chat</h1>
      <section className="card chat" aria-label="Messages">
        <ul className="chat-log">
          {status === "CanLoadMore" && (
            <li className="more">
              <button className="btn small" onClick={() => loadMore(PAGE)}>Load earlier messages</button>
            </li>
          )}
          {messages.length === 0 && <li className="chat-empty">No messages yet. Say hello, then open this page in another window.</li>}
          {messages.map((m) => (
            <li key={m._id} className={`msg${m.authorId === viewer?.userId ? " mine" : ""}`}>
              <small>{m.authorName} · <time dateTime={new Date(m._creationTime).toISOString()}>{clock.format(m._creationTime)}</time></small>
              <p>{m.body}</p>
            </li>
          ))}
          <li ref={end} aria-hidden />
        </ul>
        <form className="chat-form" onSubmit={submit}>
          <input type="text" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a message" aria-label="Message" maxLength={2000} autoComplete="off" />
          <button className="btn primary" disabled={!body.trim()}>Send</button>
        </form>
        {error && <p className="error" role="alert" style={{ padding: "0 1rem" }}>{error}</p>}
      </section>
    </main>
  );
}
