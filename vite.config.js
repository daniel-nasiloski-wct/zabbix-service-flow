import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// `npm run build` gera o bundle dentro do módulo do Zabbix (assets/js e assets/css, nomes fixos,
// referenciados pela view). `npm run dev` serve o index.html da raiz: um harness que imita a página
// do Zabbix e lê dev/fixture.json, para iterar no mapa sem um Zabbix por perto.
export default defineConfig({
  plugins: [react()],
  base: './',
  server: { port: 8000 },
  build: {
    outDir: 'zabbix_service_dashboard/assets',
    emptyOutDir: false,
    assetsDir: '',
    cssCodeSplit: false,
    sourcemap: false,
    target: ['es2020', 'safari15'],
    rollupOptions: {
      input: 'src/main.jsx',
      output: {
        entryFileNames: 'js/service-dashboard.js',
        chunkFileNames: 'js/[name].js',
        assetFileNames: (asset) => (asset.name?.endsWith('.css') ? 'css/service-dashboard.css' : 'img/[name][extname]'),
      },
    },
  },
})
