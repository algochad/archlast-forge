import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { preload } from "./Doc";

await preload(location.pathname.split("/")[1]).catch(() => {}); // a failed chunk shows its reload message in the page

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
);
