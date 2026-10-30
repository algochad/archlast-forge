// The shadcn/ui starter for full-stack apps: what the scaffolder asks, and the files it adds to the app. The components and the theme
// data in template/shadcn come from the shadcn registry; `bun scripts/update-shadcn.ts` refreshes them.
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BASE_COLORS = ["neutral", "stone", "zinc", "mauve", "olive", "mist", "taupe"] as const;
export type BaseColor = (typeof BASE_COLORS)[number];

export const BASE_COLOR_HINTS: Record<BaseColor, string> = {
  neutral: "plain grays",
  stone: "warm grays",
  zinc: "cool grays",
  mauve: "purple-tinted grays",
  olive: "green-tinted grays",
  mist: "blue-tinted grays",
  taupe: "brown-tinted grays",
};

export const parseBaseColor = (text: string): BaseColor => {
  const name = text.trim().toLowerCase();
  if (!(BASE_COLORS as readonly string[]).includes(name)) throw new Error(`Unknown base color "${text}". Choose from ${BASE_COLORS.join(", ")}.`);
  return name as BaseColor;
};

/** What the components and the CSS import. Versions are what `shadcn init` installs today. */
const DEPENDENCIES = {
  "@base-ui/react": "^1.9.0",
  "@fontsource-variable/geist": "^5.3.0",
  "class-variance-authority": "^0.7.1",
  cn: "^0.5.1",
  "lucide-react": "^1.65.0",
  shadcn: "^4.23.0",
  tailwindcss: "^4.3.3",
  "tw-animate-css": "^1.4.0",
};
/** Tailwind's own Bun plugin: the framework's build loads it when the project has it. */
const DEV_DEPENDENCIES = { "bun-plugin-tailwind": "^0.1.2" };

const TEMPLATE = new URL("../template/shadcn", import.meta.url).pathname;

const block = (selector: string, vars: Record<string, string>) => `${selector} {\n${Object.entries(vars).map(([name, value]) => `    --${name}: ${value};`).join("\n")}\n}`;

/** app/styles.css: Tailwind, the shadcn base styles and the theme variables of the chosen base color. */
export function renderStyles(baseColor: BaseColor): string {
  const colors = JSON.parse(readFileSync(join(TEMPLATE, "colors.json"), "utf8")) as Record<BaseColor, { light: Record<string, string>; dark: Record<string, string> }>;
  const css = readFileSync(join(TEMPLATE, "app", "styles.css"), "utf8");
  return css.replace("/*:root*/", () => block(":root", colors[baseColor].light)).replace("/*.dark*/", () => block(".dark", colors[baseColor].dark));
}

/** components.json, which `bunx shadcn@latest add <component>` reads. */
export const renderComponentsJson = (baseColor: BaseColor) =>
  JSON.stringify(
    {
      $schema: "https://ui.shadcn.com/schema.json",
      style: "base-nova",
      rsc: false,
      tsx: true,
      tailwind: { config: "", css: "app/styles.css", baseColor, cssVariables: true, prefix: "" },
      iconLibrary: "lucide",
      rtl: false,
      aliases: { components: "@/components", utils: "@/lib/utils", ui: "@/components/ui", lib: "@/lib", hooks: "@/hooks" },
      menuColor: "default",
      menuAccent: "subtle",
      registries: {},
    },
    null,
    2,
  ) + "\n";

const README_SECTION = `
## UI: shadcn/ui

The pages use [shadcn/ui](https://ui.shadcn.com) on Tailwind CSS v4: components are in \`app/components/ui\`, the theme (the base color you chose) is the variables in \`app/styles.css\`, and \`components.json\` tells the shadcn CLI where things go. Add a component with \`bunx shadcn@latest add dialog\`. The build compiles Tailwind through \`bun-plugin-tailwind\`, so \`app/styles.css\` stays the one place for styles. Dark mode follows the system until the toggle in the header is used; it sets \`class="dark"\` on \`<html>\`.
`;

const patch = (file: string, change: (json: any) => void) => {
  const json = JSON.parse(readFileSync(file, "utf8"));
  change(json);
  writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
};

/** Adds shadcn/ui to a full-stack app that was just copied from the templates (before `__NAME__` is filled in). */
export function addShadcn(target: string, baseColor: BaseColor) {
  cpSync(join(TEMPLATE, "app"), join(target, "app"), { recursive: true }); // pages and chrome written with the components; they replace the plain ones
  writeFileSync(join(target, "app", "styles.css"), renderStyles(baseColor));
  writeFileSync(join(target, "components.json"), renderComponentsJson(baseColor));
  patch(join(target, "package.json"), (pkg) => {
    pkg.dependencies = { ...pkg.dependencies, ...DEPENDENCIES };
    pkg.devDependencies = { ...pkg.devDependencies, ...DEV_DEPENDENCIES };
  });
  patch(join(target, "tsconfig.json"), (ts) => void (ts.compilerOptions.paths = { "@/*": ["./app/*"] }));
  writeFileSync(join(target, "README.md"), readFileSync(join(target, "README.md"), "utf8").trimEnd() + "\n" + README_SECTION);
}
