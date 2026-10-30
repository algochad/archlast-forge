declare module "*.mdx" {
  import type { Doc } from "./doc";
  export const headings: Doc["headings"];
  const Content: Doc["default"];
  export default Content;
}
