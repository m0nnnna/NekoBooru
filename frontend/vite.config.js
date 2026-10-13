import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv, searchForWorkspaceRoot } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  // Backend address for the dev /api proxy. Defaults to :8772; override by
  // setting VITE_BACKEND (env var or a gitignored frontend/.env.local or
  // .env.development.local file). Must match the backend's NEKO_PORT.
  const env = loadEnv(mode, process.cwd(), '')
  const backend = env.VITE_BACKEND || 'http://127.0.0.1:8772'
  const frontendPort = Number(env.VITE_FRONTEND_PORT || env.NEKO_FRONTEND_PORT || 5173)

  return {
    plugins: [vue()],
    base: '/',
    build: {
      outDir: 'dist',
      assetsDir: 'assets',
    },
    server: {
      // src/remote/importRules.js imports browser-extension/booru-import-rules.js,
      // the one copy of the booru import rules both clients load.
      fs: {
        allow: [
          searchForWorkspaceRoot(process.cwd()),
          fileURLToPath(new URL('../browser-extension/booru-import-rules.js', import.meta.url)),
        ],
      },
      port: frontendPort,
      strictPort: true,
      proxy: {
        '/api': {
          target: backend,
          changeOrigin: false,
          secure: false,
          ws: true,
          timeout: 600000,
          proxyTimeout: 600000,
          configure: (proxy, _options) => {
            proxy.on('error', (err, req, res) => {
              console.error('Proxy error for', req.url, ':', err.message)
              if (res && !res.headersSent) {
                res.writeHead(503, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({
                  detail: `Backend connection failed (${backend}). Ensure the backend is running.`,
                }))
              }
            })
            proxy.on('proxyReq', (proxyReq, req, _res) => {
              console.log('Proxying:', req.method, req.url, '->', backend)
            })
          },
        },
      },
    },
  }
})
