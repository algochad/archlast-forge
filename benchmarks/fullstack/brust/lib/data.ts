// The same rows and the same formatting code as the other apps (../shared/data.ts), run in the loader: brust pages are fed finished strings.
import { formatDate, formatMoney, products } from '../../shared/data'

export interface Row {
  id: number
  sku: string
  name: string
  price: string
  stock: number
  added: string
}

export async function productsLoader(): Promise<{ rows: Row[] }> {
  return { rows: products().map((p) => ({ id: p.id, sku: p.sku, name: p.name, price: formatMoney(p.priceCents), stock: p.stock, added: formatDate(p.createdAt) })) }
}
