export function meta() {
  return [{ title: "Home" }];
}

const FEATURES = [
  ["Rendered on the server", "Every page arrives as HTML with its data already in it."],
  ["Typed from end to end", "Loaders, actions and components share their types."],
  ["One deploy", "Pages, API and assets ship together."],
];

export default function Home() {
  return (
    <main>
      <h1>Realtime. Full-stack. One deploy.</h1>
      <p>Server-rendered React with a typed backend.</p>
      <ul>
        {FEATURES.map(([title, text]) => (
          <li key={title}>
            <h3>{title}</h3>
            <p>{text}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}
