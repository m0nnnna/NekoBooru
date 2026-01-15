import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  base: '/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: false,
        secure: false,
        ws: true,
        timeout: 10000,
        proxyTimeout: 10000,
        configure: (proxy, _options) => {
          proxy.on('error', (err, req, res) => {
            console.error('Proxy error for', req.url, ':', err.message)
            // Provide a helpful error response
            if (res && !res.headersSent) {
              res.writeHead(503, {
                'Content-Type': 'application/json',
              })
              res.end(JSON.stringify({ 
                detail: 'Backend server connection failed. Please ensure the backend is running on port 8000.' 
              }))
            }
          })
          proxy.on('proxyReq', (proxyReq, req, _res) => {
            console.log('Proxying:', req.method, req.url, '-> http://127.0.0.1:8000')
          })
        },
      },
    },
  },
})
