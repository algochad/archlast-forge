import { useAuth } from "@archlast/forge-react";
import { useState } from "react";
import type { authPlugins } from "../root";

/** Uses a client plugin's action through useAuth, typed with app/root.tsx's authPlugins. */
export default function Plugin() {
  const auth = useAuth<typeof authPlugins>();
  const [said, setSaid] = useState(typeof auth.hello === "function" ? auth.hello("server and browser") : "no plugin");
  return (
    <button id="plugin" onClick={() => setSaid(auth.hello("a click"))}>
      {said}
    </button>
  );
}
