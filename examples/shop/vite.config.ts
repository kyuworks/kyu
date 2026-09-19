import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { isOrdersPageRequest } from './web/lib/devProxy.js'

// The ui process's own port (src/config.ts DEFAULT_UI_PORT); override it to
// smoke-test against a spare port without touching the running one.
const uiOrigin = `http://127.0.0.1:${process.env['QTAXIS_SHOP_UI_PORT'] ?? '3333'}`

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: path.resolve(import.meta.dirname, 'dist/web'), emptyOutDir: true },
  server: {
    proxy: {
      '/ui.json': uiOrigin,
      '/bus.json': uiOrigin,
      '/products.json': uiOrigin,
      '/orders': {
        target: uiOrigin,
        bypass: (req) => (isOrdersPageRequest(req.method, req.url) ? '/index.html' : undefined),
      },
      '/shipments': uiOrigin,
    },
  },
})
