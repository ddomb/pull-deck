// Fold this mod's layout block down to its header and back. The block is found in the shown
// layout by its mod name; folding resizes it to `px` (layout.resize) and remembers the size it
// had, so unfolding gives the room back. The choice lives in this mod's localStorage, so it
// holds across restarts.
import { layout, run } from 'herdr'

const find = (node, mod) => {
  if (node?.content?.mod === mod) return node
  for (const child of node?.children ?? []) {
    const found = find(child, mod)
    if (found) return found
  }
  return null
}

export function collapser(mod, px, fallback) {
  const node = () => find(layout(), mod)
  const saved = () => {
    try {
      return JSON.parse(localStorage.getItem('collapse.size') ?? 'null') ?? fallback
    } catch {
      return fallback
    }
  }
  return {
    collapsed: () => localStorage.getItem('collapse.on') === '1',
    /** Folds the block again after a restart or a layout reload, if it was left folded. */
    apply() {
      const block = node()
      if (block?.id && this.collapsed() && block.size?.px !== px) run('layout.resize', { id: block.id, px })
    },
    toggle() {
      const block = node()
      if (!block?.id) return
      if (this.collapsed()) {
        localStorage.removeItem('collapse.on')
        run('layout.resize', { id: block.id, ...saved() })
      } else {
        if (block.size && block.size.px !== px) localStorage.setItem('collapse.size', JSON.stringify(block.size))
        localStorage.setItem('collapse.on', '1')
        run('layout.resize', { id: block.id, px })
      }
    },
  }
}
