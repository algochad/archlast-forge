const FEATURES = [
  { title: 'Rendered on the server', text: 'Every page arrives as HTML with its data already in it.' },
  { title: 'Typed from end to end', text: 'Loaders, actions and components share their types.' },
  { title: 'One deploy', text: 'Pages, API and assets ship together.' },
]

export default function HomePage() {
  return (
    <main>
      <h1>Realtime. Full-stack. One deploy.</h1>
      <p>Server-rendered React with a typed backend.</p>
      <ul>
        {FEATURES.map((f) => (
          <li key={f.title}>
            <h3>{f.title}</h3>
            <p>{f.text}</p>
          </li>
        ))}
      </ul>
    </main>
  )
}
