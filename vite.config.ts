import { defineConfig } from 'vite'

// Locked decisions (see .sisyphus/notepads/playground-v2/decisions.md):
//   #1  Cloudflare Pages root-serves  -> base: '/'
//   #2  Cloudflare Pages does brotli  -> no compression plugin
//   #11 Modern browsers only          -> target: 'es2022'
export default defineConfig({
  base: '/',
  assetsInclude: ['**/*.wasm', '**/*.whl', '**/*.zip'],
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes('/node_modules/@codemirror/') ||
            id.includes('/node_modules/codemirror/') ||
            id.includes('/node_modules/@lezer/')
          ) {
            return 'codemirror'
          }
          if (id.includes('/@xpr-lang/xpr/') || id.includes('/xpr-js/dist/')) {
            return 'xpr-lang'
          }
        },
      },
    },
  },
})
