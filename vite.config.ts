import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'

/**
 * D-3: the committed index lives at the repo root. Vite's dev server already serves it
 * from there; this copies it into dist/ so the built site can fetch it too.
 */
function problemIndex(): Plugin {
  return {
    name: 'idd-pset:problem-index',
    generateBundle() {
      let source: string
      try {
        source = readFileSync('index.json', 'utf8')
      } catch {
        this.warn('index.json not found; shipping an empty index (every key falls back to D-8)')
        source = JSON.stringify({ book: 'Unknown book', problems: {} }, null, 2)
      }
      this.emitFile({ type: 'asset', fileName: 'index.json', source })
    },
  }
}

// D-1: static build for GitHub Pages. A relative base works for both
// <user>.github.io/<repo>/ and local `vite preview` without hardcoding the repo name.
// D-13: no CDN at runtime -- everything, pdf.js worker included, is emitted into dist/.
export default defineConfig({
  base: './',
  plugins: [problemIndex()],
  build: {
    outDir: 'dist',
    target: 'es2022',
    assetsInlineLimit: 0,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
