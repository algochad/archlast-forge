/** An app's own component for its MDX: the default export, by the file's name. */
export default function Badge({ children }: { children?: React.ReactNode }) {
  return <span data-badge="">{children}</span>;
}
