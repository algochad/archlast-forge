import { defineRoutes } from '@brust/core/routes'
import Layout from './components/Layout'
import { productsLoader } from './lib/data'
import HomePage from './pages/HomePage'
import ProductsPage from './pages/ProductsPage'

export const routes = defineRoutes([
  {
    Component: Layout,
    children: [
      { path: '/', Component: HomePage },
      { path: '/products', Component: ProductsPage, loader: productsLoader },
    ],
  },
])
