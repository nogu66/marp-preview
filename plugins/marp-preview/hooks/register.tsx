import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Deck } from '../types'
import { basename, changedSlide, dirname, frontmatter, parse } from './lib/deck'

const PANE = 'marp-preview'
const TITLE = 'Marp Preview'
const POLL_MS = 1000
/** marp logs a conversion's slides in one burst: this long without a line and it is over. */
const QUIET_MS = 100
/** Polls a saved deck may go unrendered before the watcher counts as stuck: once it has rendered, and before. */
const STUCK_POLLS = 8
const FIRST_RENDER_POLLS = 90
/** Watchers in a row that ended having rendered nothing, after which the pane waits for the deck to change. */
const RESTART_MAX = 3
/** How many folders above the deck are searched for marp and for themes. */
const UP_MAX = 6
/** A terminal cell is about 2.1 times as tall as it is wide. */
const CELL_RATIO = 2.1

const deckAtom = atom({ plugin: 'marp-preview', key: 'deck' } as const, null)

type Dollar = EngineInterface

type Timer = ReturnType<Dollar['clock']['after']>

/** marp in watch mode: one process, and one browser, for as long as the pane shows the deck. */
type Watcher = {
  path: string
  stream: ReturnType<Dollar['process']['spawn']>
  /** Stopped on purpose (the pane closed, another deck opened): not to be started again. */
  isStopped: boolean
  hasRendered: boolean
  /** The conversion marp is logging now: whether it wrote slides, and the error it reported. */
  hasSlides: boolean
  error: string
  quiet?: Timer
}

// Module variables hold only what a reload may lose. A reload also ends the watcher:
// the engine kills a spawned child when its module unloads
let watcher: Watcher | undefined
let failures = 0
let stalePolls = 0
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
  // Past the session's root too: Claude Code may be started in the deck's own folder,
  // with marp installed and the themes kept a level or two above it
  const dirs: string[] = []
  let dir = dirname(path)
  for (let depth = 0; depth < UP_MAX; depth++) {
    dirs.push(dir)
    if (dir === '/') break
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

/** The most recently changed deck (a .md with `marp: true`) under `dir`. */
async function newestDeck($: Dollar, dir: string): Promise<string | undefined> {
  const found = await $.process
    .run([
      'grep',
      '-rlE',
      '--include=*.md',
      '--exclude-dir=node_modules',
      '--exclude-dir=.git',
      '--exclude-dir=dist',
      '^marp: *true',
      dir,
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

/** With no deck named: one under the folder the session is in, else anywhere in the project. */
async function findDeck($: Dollar, cwd: string): Promise<string | undefined> {
  const root = await $.session.root()

  return (await newestDeck($, cwd)) ?? (root === cwd ? undefined : await newestDeck($, root))
}

function stopWatcher(): void {
  const mine = watcher
  watcher = undefined
  if (!mine) return
  mine.isStopped = true
  mine.quiet?.cancel()
  // Ending the stream is what ends marp, and its browser with it
  void mine.stream.return({ code: null, signal: null }).catch(() => undefined)
}

/** A conversion is over: show its slides, or say why there are none. */
async function finish($: Dollar, mine: Watcher): Promise<void> {
  const { hasSlides, error } = mine
  mine.hasSlides = false
  mine.error = ''
  const deck = await read($, deckAtom)
  if (watcher !== mine || !deck || deck.path !== mine.path) return
  const stat = await $.fs.stat(deck.path).catch(() => undefined)
  seenMtime = stat?.mtimeMs
  stalePolls = 0
  if (!hasSlides) {
    await update($, deckAtom, (now): Deck | null =>
      now ? { ...now, status: 'error', message: error.slice(0, 200) } : now,
    )

    return
  }
  mine.hasRendered = true
  failures = 0
  // Claude or an editor changed the deck: find the slide, to mark it and scroll to it
  const text = await $.fs.read(deck.path).catch(() => undefined)
  const changed = seenText === undefined || text === undefined ? undefined : changedSlide(seenText, text)
  seenText = text ?? seenText
  await update($, deckAtom, (now): Deck | null =>
    now
      ? { ...now, status: 'idle', message: '', generation: now.generation + 1, index: changed ?? now.index }
      : now,
  )
  if (changed !== undefined) await scrollTo($, { key: `slide-${changed + 1}` })
}

/** One line of marp's log: a slide written, an error, or the start of a conversion. */
async function hear($: Dollar, mine: Watcher, line: string): Promise<void> {
  const isSlide = line.includes(' => ')
  const isError = /\[\s*ERROR\s*\]/.test(line)
  if (isSlide) mine.hasSlides = true
  if (isError) mine.error = line.replace(/^.*?\]\s*/, '')
  if (isSlide || isError) {
    mine.quiet?.cancel()
    mine.quiet = $.clock.after(QUIET_MS, () => void finish($, mine))

    return
  }
  if (!/Converting|Insecure local file/.test(line)) return
  await update($, deckAtom, (now): Deck | null =>
    now && now.status !== 'rendering' ? { ...now, status: 'rendering', message: '' } : now,
  )
}

/** Starts marp watching the deck: it renders once now, and again each time the deck is saved. */
function startWatcher($: Dollar, deck: Deck): void {
  stopWatcher()
  const stream = $.process.spawn({
    argv: [
      ...deck.bin,
      deck.path,
      '--no-stdin',
      '--allow-local-files',
      ...deck.themeSets.flatMap(dir => ['--theme-set', dir]),
      '--watch',
      '--images',
      'png',
      '-o',
      `${deck.outDir}/s.png`,
    ],
    cwd: dirname(deck.path),
  })
  const mine: Watcher = { path: deck.path, stream, isStopped: false, hasRendered: false, hasSlides: false, error: '' }
  watcher = mine
  stalePolls = 0
  void (async () => {
    let rest = ''
    let reason = ''
    try {
      for await (const chunk of stream) {
        const lines = (rest + chunk.text).split('\n')
        rest = lines.pop() ?? ''
        for (const line of lines) await hear($, mine, line)
      }
    } catch (error) {
      reason = String(error)
    }
    mine.quiet?.cancel()
    if (watcher === mine) watcher = undefined
    if (mine.isStopped) return
    // marp ended on its own: the next poll starts another, unless it keeps ending with nothing to show
    failures = mine.hasRendered ? 0 : failures + 1
    if (failures < RESTART_MAX) return
    const stat = await $.fs.stat(deck.path).catch(() => undefined)
    seenMtime = stat?.mtimeMs
    await update($, deckAtom, (now): Deck | null =>
      now ? { ...now, status: 'error', message: (mine.error || reason || 'marp stopped').slice(0, 200) } : now,
    )
  })()
}

/** Keeps a watcher alive while the pane is open: starts one when none runs, replaces one that is stuck. */
function startPolling($: Dollar): void {
  if (isPolling) return
  isPolling = true
  $.clock.every(POLL_MS, () => {
    void (async () => {
      if (!isOpen) return
      // The pane's close is heard at `ui.close`; this catches one that was not, within a poll
      const panes = await $.ui.panes().catch(() => undefined)
      if (panes && !panes.some(pane => pane.id === PANE)) {
        isOpen = false
        stopWatcher()

        return
      }
      const deck = await read($, deckAtom)
      if (!deck) return
      const stat = await $.fs.stat(deck.path).catch(() => undefined)
      const isUnrendered = stat !== undefined && stat.mtimeMs !== seenMtime
      if (!watcher) {
        // After giving up, a change to the deck is the cue to try again
        if (failures >= RESTART_MAX && !isUnrendered) return
        if (failures >= RESTART_MAX) failures = 0
        startWatcher($, deck)

        return
      }
      stalePolls = isUnrendered ? stalePolls + 1 : 0
      if (stalePolls >= (watcher.hasRendered ? STUCK_POLLS : FIRST_RENDER_POLLS)) startWatcher($, deck)
    })()
  })
}

async function openDeck($: Dollar, given: string): Promise<string> {
  const cwd = await $.session.cwd()
  const current = await read($, deckAtom)
  const asked = given.trim().replace(/^["']|["']$/g, '')
  const named = asked === '' ? undefined : (asked.startsWith('/') ? asked : `${cwd}/${asked}`).replace(/\/+$/, '')
  // A folder stands for the newest deck in it
  const path =
    named === undefined
      ? (current?.path ?? (await findDeck($, cwd)))
      : (await isDir($, named))
        ? await newestDeck($, named)
        : named
  if (path === undefined) {
    return `No Marp deck (a .md with \`marp: true\`) found${named === undefined ? '' : ` in ${named}`}. Name one: /marp <path>`
  }
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
  failures = 0
  startPolling($)
  await $.ui.open({ id: PANE, title: TITLE, columns: 88, rows: 44 })
  const deck = await read($, deckAtom)
  if (deck && watcher?.path !== deck.path) startWatcher($, deck)

  return `Opened ${basename(path)} in Marp Preview.`
}

type Target = Parameters<Dollar['ui']['scroll']>[0]['to']

/** Scrolls the pane; does nothing when it cannot move (the pane is closed, say). */
async function scrollTo($: Dollar, to: Target): Promise<void> {
  // A slide lands mid-window, so the page number above it shows too; an edge lands on the edge
  const block = typeof to === 'string' ? 'start' : 'center'
  await $.ui.scroll({ in: PANE, to, block }).catch(() => undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'marp',
      description: 'Open a live preview of a Marp deck in a pane',
      argumentHint: '[deck.md or folder]',
    })
    // The pane stays open across a reload, the watcher does not: the poll starts another
    const panes = await $.ui.panes()
    if (panes.some(pane => pane.id === PANE)) {
      isOpen = true
      startPolling($)
    }

    return next(e)
  })

  on('command.run', { command: 'marp' }, async ($, e) => ({ text: await openDeck($, e.args) }))

  on('ui.close', ($, e, next) => {
    if (e.id === PANE) {
      isOpen = false
      stopWatcher()
    }

    return next(e)
  })

  // A /clear keeps the process and the pane, so the watcher stays; any other end stops it
  on('session.end', ($, e, next) => {
    if (e.reason !== 'clear') {
      isOpen = false
      stopWatcher()
    }

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
          <Text dimColor>Open a deck with /marp [deck.md or folder].</Text>
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
