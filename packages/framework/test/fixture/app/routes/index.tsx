import { anyApi } from "@archlast/forge-runtime";
import { useQuery } from "@archlast/forge-react";
import { useState } from "react";
import type { LoaderArgs } from "@archlast/forge-framework";

const api = anyApi;

export const loader = async ({ ctx }: LoaderArgs) => {
  await ctx.query(api.messages.list);
  return { title: "Home" };
};

export default function Home() {
  const messages = useQuery(api.messages.list) as { _id: string; body: string }[] | undefined;
  const [clicks, setClicks] = useState(0);
  return (
    <main>
      <title>Home page</title>
      <h1>Home</h1>
      <ul id="messages">{messages?.map((m) => <li key={m._id}>{m.body}</li>)}</ul>
      <button id="counter" onClick={() => setClicks(clicks + 1)}>clicked {clicks}</button>
    </main>
  );
}
