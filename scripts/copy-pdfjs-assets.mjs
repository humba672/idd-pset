// D-13: pdf.js needs its cmaps and standard fonts at runtime. They are copied out of
// node_modules into public/ at install time so the deployed site serves them itself
// instead of reaching for a CDN. public/pdfjs is generated, not committed.
import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const from = resolve(root, 'node_modules/pdfjs-dist')
const to = resolve(root, 'public/pdfjs')

await rm(to, { recursive: true, force: true })
await mkdir(to, { recursive: true })
for (const dir of ['cmaps', 'standard_fonts']) {
  await cp(resolve(from, dir), resolve(to, dir), { recursive: true })
}
console.log('copied pdf.js cmaps and standard_fonts to public/pdfjs')
