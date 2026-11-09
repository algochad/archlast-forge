import Link from "next/link";

export const metadata = { title: "Bench" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>
          <Link href="/">Bench</Link>
          <nav>
            <Link href="/">Home</Link>
            <Link href="/products">Products</Link>
          </nav>
        </header>
        {children}
        <footer>Built for the benchmark</footer>
      </body>
    </html>
  );
}
