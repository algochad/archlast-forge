import { greet } from "./lib.ts";
document.getElementById("app")!.textContent = greet("SITE_MARKER_ONE");
console.log("BROWSER_LOG_MARKER");
// Holds the page's load event open for a moment so a headless browser dumping the page at load does not exit before the
// dev socket (live reload, console forwarding) has connected. site-server.ts answers /slow.png after a delay.
const slow = new Image();
slow.src = "/slow.png";
document.body.appendChild(slow);
