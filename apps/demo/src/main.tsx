import '@fontsource-variable/space-grotesk'
import { ArchlastForgeClient, ArchlastForgeProvider } from '@archlast-forge/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'

// Same origin: Vite proxies /trpc and /api to the backend.
const client = new ArchlastForgeClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ArchlastForgeProvider client={client}>
      <App />
    </ArchlastForgeProvider>
  </StrictMode>,
)
