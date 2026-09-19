import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

/** `index.html` is missing its own `<div id="root">` mount point — a build defect, not a visitor's fault. */
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
