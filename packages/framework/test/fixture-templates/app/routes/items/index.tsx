import { useLoaderData } from "@archlast/forge-framework";
import { initials, money, upper } from "../../format";

export async function loader() {
  return {
    title: "Items",
    items: [
      { id: 1, name: "Anvil Co", priceCents: 1999, tags: ["heavy", "metal"] },
      { id: 2, name: "Bolt & Nut <Ltd>", priceCents: 5, tags: [] },
      { id: 3, name: "Cable", priceCents: 123456, tags: ["long"] },
    ],
    note: null as string | null,
  };
}

export default function Items() {
  const { title, items, note } = useLoaderData<typeof loader>();
  return (
    <main>
      <title>{`${title} (${items.length})`}</title>
      <h1>{title}</h1>
      {note && <p>{note}</p>}
      {items.length === 0 ? <p>Nothing here</p> : null}
      <table>
        <tbody>
          {items.map((p, i) => (
            <tr key={p.id} className={i % 2 === 0 ? undefined : "odd"}>
              <td>{i + 1}</td>
              <td title={upper(p.name)}>{p.name}</td>
              <td>{initials(p.name)}</td>
              <td>{money(p.priceCents)}</td>
              <td>
                {p.tags.length ? (
                  <ul>
                    {p.tags.map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ul>
                ) : (
                  "no tags"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
