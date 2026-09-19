import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

/** The element `index.html` is missing this entry point's own mount point, not a user-facing failure. */
export class MissingRootElementError extends Error {
  constructor() {
    super('index.html is missing <div id="root">')
    this.name = 'MissingRootElementError'
  }
}

const root = document.getElementById('root')
if (root === null) throw new MissingRootElementError()

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
