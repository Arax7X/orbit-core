import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './layout.css'
import GlobePage from './pages/Globe.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <GlobePage />
  </StrictMode>,
)
