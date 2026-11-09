import { products, formatDate, formatMoney } from "../../../shared/data";

export const dynamic = "force-dynamic";
export const metadata = { title: "Products" };

export default async function Products() {
  const rows = await Promise.resolve(products());
  return (
    <main>
      <h1>Products</h1>
      <table>
        <thead>
          <tr><th>SKU</th><th>Name</th><th>Price</th><th>Stock</th><th>Added</th></tr>
        </thead>
        <tbody>
          {rows.map((p) => (
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
