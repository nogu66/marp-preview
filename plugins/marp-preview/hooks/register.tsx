import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Deck } from '../types'
import { basename, changedSlide, dirname, frontmatter, parse } from './lib/deck'

const PANE = 'marp-preview'
const TITLE = 'Marp Preview'
const POLL_MS = 1000
/** A terminal cell is about 2.1 times as tall as it is wide. */
const CELL_RATIO = 2.1

const deckAtom = atom({ plugin: 'marp-preview', key: 'deck' } as const, null)

type Dollar = EngineInterface

// Module variables hold only what a reload may lose
let isRendering = false
let isStale = false
let isOpen = false
let isPolling = false
let seenMtime: number | undefined
/** The text last rendered: an outside edit is compared with it to find the slide that changed. */
let seenText: string | undefined
function hash(text: string): string {
  let value = 5381
  for (let i = 0; i < text.length; i++) value = ((value * 33) ^ text.charCodeAt(i)) >>> 0

  return value.toString(16)
}

function widthOf(char: string): number {
  return (char.codePointAt(0) ?? 0) > 0xff ? 2 : 1
}

function fit(text: string, columns: number): string {
  let used = 0
  let out = ''
  for (const char of text) {
    used += widthOf(char)
    if (used > columns - 1) return `${out}…`
    out += char
  }

  return out
}

async function isDir($: Dollar, path: string): Promise<boolean> {
  const stat = await $.fs.stat(path).catch(() => undefined)

  return stat?.kind === 'dir'
}

/** Finds marp itself and the theme folders in the folders above the deck. */
async function locate($: Dollar, path: string): Promise<Pick<Deck, 'bin' | 'themeSets'>> {
  const root = await $.session.root()
  const dirs: string[] = []
  let dir = dirname(path)
  for (let depth = 0; depth < 6; depth++) {
    dirs.push(dir)
    if (dir === root || dir === '/') break
    dir = dirname(dir)
  }
  let bin = ['npx', '--yes', '@marp-team/marp-cli']
  const themeSets: string[] = []
  let hasBin = false
  for (const one of dirs) {
    for (const candidate of [`${one}/node_modules/.bin/marp`, `${one}/marp/node_modules/.bin/marp`]) {
      if (hasBin || !(await $.fs.exists(candidate))) continue
      bin = [candidate]
      hasBin = true
    }
    for (const candidate of [`${one}/theme`, `${one}/themes`, `${one}/marp/themes`]) {
      if (await isDir($, candidate)) themeSets.push(candidate)
    }
  }

  return { bin, themeSets }
}

async function findDeck($: Dollar): Promise<string | undefined> {
  const root = await $.session.root()
  const found = await $.process
    .run([
      'grep',
      '-rlE',
      '--include=*.md',
      '--exclude-dir=node_modules',
      '--exclude-dir=.git',
      '--exclude-dir=dist',
      '^marp: *true',
      root,
    ])
    .catch(() => undefined)
  const paths = (found?.stdout ?? '').split('\n').filter(Boolean).slice(0, 40)
  let newest: { path: string; mtimeMs: number } | undefined
  for (const path of paths) {
    const stat = await $.fs.stat(path).catch(() => undefined)
    if (stat && (!newest || stat.mtimeMs > newest.mtimeMs)) newest = { path, mtimeMs: stat.mtimeMs }
  }

  return newest?.path
}

function runMarp($: Dollar, deck: Deck, output: string[]): Promise<{ exitCode: number; stderr: string }> {
  return $.process
    .run(
      [
        ...deck.bin,
        deck.path,
        '--no-stdin',
        '--allow-local-files',
        ...deck.themeSets.flatMap(dir => ['--theme-set', dir]),
        ...output,
      ],
      { cwd: dirname(deck.path), timeoutMs: 180_000 },
    )
    .catch((error: unknown) => ({ exitCode: 1, stderr: String(error) }))
}

async function render($: Dollar): Promise<void> {
  const deck = await read($, deckAtom)
  if (!deck) return
  if (isRendering) {
    isStale = true

    return
  }
  isRendering = true
  try {
    const stat = await $.fs.stat(deck.path).catch(() => undefined)
    seenMtime = stat?.mtimeMs
    await update($, deckAtom, (now): Deck | null => (now ? { ...now, status: 'rendering', message: '' } : now))
    await $.process.run(['mkdir', '-p', deck.outDir])
    const ran = await runMarp($, deck, ['--images', 'png', '-o', `${deck.outDir}/s.png`])
    const isDone = ran.exitCode === 0
    const reason = ran.stderr.trim().split('\n').at(-1) ?? 'marp failed'
    await update($, deckAtom, (now): Deck | null =>
      now && now.path === deck.path
        ? {
            ...now,
            status: isDone ? 'idle' : 'error',
            message: isDone ? '' : reason.slice(0, 200),
            generation: isDone ? now.generation + 1 : now.generation,
          }
        : now,
    )
  } finally {
    isRendering = false
    if (isStale) {
      isStale = false
      void render($)
    }
  }
}

function startPolling($: Dollar): void {
  if (isPolling) return
  isPolling = true
  $.clock.every(POLL_MS, () => {
    void (async () => {
      if (!isOpen || isRendering) return
      const deck = await read($, deckAtom)
      if (!deck) return
      const stat = await $.fs.stat(deck.path).catch(() => undefined)
      if (!stat || stat.mtimeMs === seenMtime) return
      // Claude or an editor changed the deck: note which slide, then render again
      const text = await $.fs.read(deck.path).catch(() => undefined)
      const changed = seenText === undefined || text === undefined ? undefined : changedSlide(seenText, text)
      seenText = text ?? seenText
      if (changed !== undefined) {
        await update($, deckAtom, now => (now ? { ...now, index: changed } : now))
      }
      await render($)
      if (changed !== undefined) await scrollTo($, { key: `slide-${changed + 1}` })
    })()
  })
}

async function openDeck($: Dollar, given: string): Promise<string> {
  const cwd = await $.session.cwd()
  const current = await read($, deckAtom)
  const asked = given.trim().replace(/^["']|["']$/g, '')
  const path = asked === '' ? (current?.path ?? (await findDeck($))) : asked.startsWith('/') ? asked : `${cwd}/${asked}`
  if (path === undefined) return 'No Marp deck (a .md with `marp: true`) found. Name one: /marp <path>'
  const text = await $.fs.read(path).catch(() => undefined)
  if (typeof text !== 'string') return `Could not read ${path}`
  seenText = text
  if (current?.path !== path) {
    const { bin, themeSets } = await locate($, path)
    const deck: Deck = {
      path,
      index: 0,
      generation: 0,
      status: 'idle',
      message: '',
      outDir: `/tmp/marp-preview/${hash(path)}`,
      bin,
      themeSets,
      ratio: frontmatter(text, 'size') === '4:3' ? 4 / 3 : 16 / 9,
    }
    await update($, deckAtom, () => deck)
  }
  isOpen = true
  startPolling($)
  await $.ui.open({ id: PANE, title: TITLE, columns: 88, rows: 44 })
  void render($)

  return `Opened ${basename(path)} in Marp Preview.`
}

type Target = Parameters<Dollar['ui']['scroll']>[0]['to']

/** Scrolls the pane; does nothing when it cannot move (the pane is closed, say). */
async function scrollTo($: Dollar, to: Target): Promise<void> {
  await $.ui.scroll({ in: PANE, to, block: 'start' }).catch(() => undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'marp',
      description: 'Open a live preview of a Marp deck in a pane',
      argumentHint: '[deck.md]',
    })
    // The pane stays open across a reload: keep following the deck
    const panes = await $.ui.panes()
    if (panes.some(pane => pane.id === PANE)) {
      isOpen = true
      startPolling($)
    }

    return next(e)
  })

  on('command.run', { command: 'marp' }, async ($, e) => ({ text: await openDeck($, e.args) }))

  on('ui.close', ($, e, next) => {
    if (e.id === PANE) isOpen = false

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    // The terminal alone draws an `Image`; elsewhere the table's answer draws nothing
    const Image = e.surface === 'terminal' && 'Image' in table ? table.Image : undefined
    const deck = await read($, deckAtom)
    if (!deck) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Open a deck with /marp [deck.md].</Text>
        </Box>
      )
    }
    const text = await $.fs.read(deck.path).catch(() => '')
    const count = parse(text).slides.length
    const columns = Math.max(30, e.props.bodyColumns)
    const height = e.props.scroll.bodyRows > 0 ? e.props.scroll.bodyRows : (e.viewport?.rows ?? 40)
    // Full width; shrunk to the window's height when one slide would not fit in it
    const fitRows = Math.round(columns / deck.ratio / CELL_RATIO)
    const imageRows = Math.max(4, Math.min(fitRows, height - 2))
    const imageColumns = Math.max(8, Math.min(columns, Math.round(imageRows * deck.ratio * CELL_RATIO)))
    const pages = Array.from({ length: count }, (_, i) => i + 1)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Text bold>{fit(basename(deck.path), 28)}</Text>
          <Text dimColor>
            {count} {count === 1 ? 'slide' : 'slides'}
          </Text>
          <Button key="end" onPress={() => scrollTo($, 'end')}>⏭ Last</Button>
          {deck.status === 'rendering' && <Text color="yellow">Rendering…</Text>}
        </Box>
        {deck.status === 'error' && <Text color="red">{fit(deck.message, columns * 2)}</Text>}
        {!Image && <Text dimColor>Slides are drawn in a terminal with the kitty graphics protocol (Ghostty, kitty).</Text>}
        {Image && deck.generation === 0 && <Text dimColor>Rendering the deck…</Text>}
        {Image &&
          deck.generation > 0 &&
          pages.map(page => (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor={page !== deck.index + 1} color={page === deck.index + 1 ? 'yellow' : undefined}>
                {page} / {count}
              </Text>
              <Image
                key={`slide-${page}`}
                source={{
                  file: `${deck.outDir}/s.${String(page).padStart(3, '0')}.png`,
                  format: 'png',
                  generation: deck.generation,
                }}
                columns={imageColumns}
                rows={imageRows}
                alt={`Slide ${page}`}
              />
            </Box>
          ))}
        {count > 1 && <Button key="start" onPress={() => scrollTo($, 'start')}>⏮ First</Button>}
      </Box>
    )
  })
}
