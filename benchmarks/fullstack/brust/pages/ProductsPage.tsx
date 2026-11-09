import type { Row } from '../lib/data'

export default function ProductsPage({ rows }: { rows: Row[] }) {
  return (
    <main>
      <h1>Products</h1>
      <table>
        <thead>
          <tr>
            <th>SKU</th>
            <th>Name</th>
            <th>Price</th>
            <th>Stock</th>
            <th>Added</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}>
              <td>{p.sku}</td>
              <td>{p.name}</td>
              <td>{p.price}</td>
              <td>{p.stock}</td>
              <td>{p.added}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  )
}
