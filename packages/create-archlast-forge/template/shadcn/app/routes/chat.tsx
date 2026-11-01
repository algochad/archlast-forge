import { redirect, useTimeZone, useViewer, type LoaderArgs } from "@archlast/forge-framework";
import { ForgeError, useMutation, usePaginatedQuery } from "@archlast/forge-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
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
    <main className="mx-auto w-full max-w-5xl px-4 py-10">
      <title>Chat</title>
      <h1 className="mb-4 text-3xl font-bold tracking-tight">Chat</h1>
      <Card role="region" aria-label="Messages" className="h-[min(70dvh,40rem)] gap-0 py-0">
        <ul className="chat-log flex flex-1 flex-col gap-2 overflow-y-auto p-4">
          {status === "CanLoadMore" && (
            <li className="text-center">
              <Button variant="outline" size="sm" onClick={() => loadMore(PAGE)}>Load earlier messages</Button>
            </li>
          )}
          {messages.length === 0 && <li className="chat-empty m-auto text-center text-muted-foreground">No messages yet. Say hello, then open this page in another window.</li>}
          {messages.map((m) => {
            const mine = m.authorId === viewer?.userId;
            return (
              <li key={m._id} className={cn("msg max-w-[80%] rounded-2xl px-3.5 py-2", mine ? "mine self-end bg-primary text-primary-foreground" : "self-start bg-muted")}>
                <small className="block text-xs opacity-70">{m.authorName} · <time dateTime={new Date(m._creationTime).toISOString()}>{clock.format(m._creationTime)}</time></small>
                <p className="[overflow-wrap:anywhere]">{m.body}</p>
              </li>
            );
          })}
          <li ref={end} aria-hidden />
        </ul>
        <form className="flex gap-2 border-t p-3" onSubmit={submit}>
          <Input type="text" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a message" aria-label="Message" maxLength={2000} autoComplete="off" />
          <Button type="submit" disabled={!body.trim()}>Send</Button>
        </form>
        {error && <p className="px-4 pb-3 text-sm text-destructive" role="alert">{error}</p>}
      </Card>
    </main>
  );
}
