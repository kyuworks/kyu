import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { DEV_PROXY_EXACT_PATHS, isOrdersPageRequest } from './web/lib/devProxy.js'

// The ui process's own port (src/config.ts DEFAULT_UI_PORT); override it to
// smoke-test against a spare port without touching the running one.
const uiOrigin = `http://127.0.0.1:${process.env['QTAXIS_SHOP_UI_PORT'] ?? '3333'}`

// Built from DEV_PROXY_EXACT_PATHS so a route a page posts or fetches to
// cannot go missing here without also failing devProxy.test.ts.
const exactProxyEntries = Object.fromEntries(DEV_PROXY_EXACT_PATHS.map((route) => [route, uiOrigin]))

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  build: { outDir: path.resolve(import.meta.dirname, 'dist/web'), emptyOutDir: true },
  server: {
    proxy: {
      ...exactProxyEntries,
      '/orders': {
        target: uiOrigin,
        bypass: (req) => (isOrdersPageRequest(req.method, req.url) ? '/index.html' : undefined),
      },
    },
  },
})
