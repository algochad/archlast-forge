import { products, formatDate, formatMoney } from "../../../shared/data";
import type { Route } from "./+types/products";

export function meta() {
  return [{ title: "Products" }];
}

export async function loader() {
  return { rows: await Promise.resolve(products()) };
}

export default function Products({ loaderData }: Route.ComponentProps) {
  return (
    <main>
      <h1>Products</h1>
      <table>
        <thead>
          <tr><th>SKU</th><th>Name</th><th>Price</th><th>Stock</th><th>Added</th></tr>
        </thead>
        <tbody>
          {loaderData.rows.map((p) => (
            <tr key={p.id}>
              <td>{p.sku}</td>
              <td>{p.name}</td>
              <td>{formatMoney(p.priceCents)}</td>
              <td>{p.stock}</td>
              <td>{formatDate(p.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
