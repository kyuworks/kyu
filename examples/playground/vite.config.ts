import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The ui process's own port (src/config.ts DEFAULT_UI_PORT); override it to
// smoke-test against a spare port without touching the running one.
const uiOrigin = `http://127.0.0.1:${process.env['QTAXIS_EXAMPLE_UI_PORT'] ?? '3333'}`

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: path.resolve(import.meta.dirname, 'dist/web'), emptyOutDir: true },
  server: {
    proxy: {
      '/ui.json': uiOrigin,
      '/bus.json': uiOrigin,
      '/orders': uiOrigin,
      '/shipments': uiOrigin,
    },
  },
})
