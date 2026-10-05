export type Deck = {
  /** The open deck's absolute path. */
  path: string
  /** The slide last changed, from 0: its page number is highlighted. */
  index: number
  /** Grows with each render, so the PNG under an unchanged path is read again. */
  generation: number
  status: 'idle' | 'rendering' | 'error'
  message: string
  outDir: string
  bin: string[]
  themeSets: string[]
  /** The slide's width over its height. */
  ratio: number
}

declare module 'claude-code' {
  interface PluginState {
    'marp-preview': { deck: Deck | null }
  }
}
