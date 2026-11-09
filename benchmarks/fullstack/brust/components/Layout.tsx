import { Outlet } from '@brust/core/routes'

export default function Layout() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body>
        <header>
          <a href="/">Bench</a>
          <nav>
            <a href="/">Home</a>
            <a href="/products">Products</a>
          </nav>
        </header>
        <Outlet />
        <footer>Built for the benchmark</footer>
      </body>
    </html>
  )
}
