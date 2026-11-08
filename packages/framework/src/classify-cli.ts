// bun packages/framework/src/classify-cli.ts <app root>   prints what each route and component would ship to the browser.
import { resolve } from "node:path";
import { classifyApp, formatReport } from "./classify";

const root = resolve(process.argv[2] ?? ".");
console.log(formatReport(classifyApp(root), root));
