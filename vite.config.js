import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const stub = (name) => fileURLToPath(new URL(`./src/stubs/${name}`, import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // The globe libraries import three's WebGPU build and the h3-js hexagon
      // maths, but this app never runs them. Swapping them for small stand-ins
      // removes about 1.5 MB from the download. See src/stubs/ before removing.
      { find: /^three\/webgpu$/, replacement: stub('three-webgpu.js') },
      { find: /^three\/tsl$/, replacement: stub('three-tsl.js') },
      { find: /^h3-js$/, replacement: stub('h3-js.js') },
    ],
  },
  server: {
    proxy: {
      // CelesTrak sends no CORS header, so the browser can't fetch it directly.
      // In dev, Vite proxies /celestrak/* to https://celestrak.org/*.
      // In production, api/celestrak.js does the same job.
      '/celestrak': {
        target: 'https://celestrak.org',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/celestrak/, ''),
      },
    },
  },
})
