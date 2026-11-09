// bun packages/framework/src/classify-cli.ts <app root>   prints what each route and component would ship to the browser, and which pages the engine can print from templates.
import { join, resolve } from "node:path";
import { classifyApp, formatReport } from "./classify";
import { compileApp } from "./render-compile";
import { scanRoutes } from "./routes";

const root = resolve(process.argv[2] ?? ".");
const report = classifyApp(root);
console.log(formatReport(report, root));
const appDir = join(root, "app");
const { compiled, reasons } = compileApp(root, appDir, scanRoutes(appDir), (id) => (id === "root" ? report.root?.tier : report.routes.find((r) => r.id === id)?.tier));
console.log(["", "", "Pages the engine can print from templates (native engine, islands on)", ...[...compiled.keys()].map((id) => `  yes      ${id}`), ...[...reasons].map(([id, why]) => `  no       ${id}  (${why})`)].join("\n"));
