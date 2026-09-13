// Shared DOM helpers for the four views in D-12. No framework (D-1).

type Child = Node | string | number | null | false | undefined

interface ElProps {
  class?: string
  text?: string
  html?: string
  dataset?: Record<string, string>
  attrs?: Record<string, string>
  on?: Partial<Record<keyof HTMLElementEventMap, (ev: Event) => void>>
  [key: string]: unknown
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue
    if (key === 'class') node.className = String(value)
    else if (key === 'text') node.textContent = String(value)
    else if (key === 'html') node.innerHTML = String(value)
    else if (key === 'dataset') Object.assign(node.dataset, value)
    else if (key === 'attrs') {
      for (const [k, v] of Object.entries(value as Record<string, string>)) {
        node.setAttribute(k, v)
      }
    } else if (key === 'on') {
      for (const [evt, fn] of Object.entries(value as Record<string, (e: Event) => void>)) {
        node.addEventListener(evt, fn)
      }
    } else {
      ;(node as unknown as Record<string, unknown>)[key] = value
    }
  }
  append(node, children)
  return node
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)))
  }
}

export function clear(node: HTMLElement): HTMLElement {
  node.replaceChildren()
  return node
}

export function formatDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString()
}

/** A one-line status message that fades from the bottom of the screen. */
export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const node = el('div', { class: `toast toast-${kind}`, text: message })
  document.body.append(node)
  setTimeout(() => node.classList.add('leaving'), kind === 'error' ? 5000 : 2500)
  setTimeout(() => node.remove(), kind === 'error' ? 5400 : 2900)
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = el('a', { href: url, download: filename })
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept, style: 'display:none' })
    input.addEventListener('change', () => {
      resolve(input.files?.[0] ?? null)
      input.remove()
    })
    document.body.append(input)
    input.click()
  })
}
