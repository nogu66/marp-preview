import { expect, mock, test } from 'claude-code/testing'

const PATH = '/work/talks/deck.md'
const DECK = ['---', 'marp: true', 'theme: brand', '---', '', '# One', '', '---', '', '# Two', '', '---', '', '# Three', ''].join('\n')

const PANE = {
  plugin: 'marp-preview',
  component: 'Pane',
  requestId: 'marp-preview',
  props: {
    title: 'Marp Preview',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 50 },
    view: {},
  },
  viewport: { columns: 200, rows: 60 },
} as const

/** marp as the test runs it: a child that logs what the test tells it to, until it is ended or killed. */
type Child = { argv: string[]; isAlive: boolean; log: (text: string) => void; exit: () => void }

test('/marp keeps one marp watching the deck, restarts it when it dies or hangs, and stops it with the pane', async ($, on) => {
  const files = new Map([[PATH, DECK]])
  const children: Child[] = []
  let mtimeMs = 1
  const clock = mock.clock(on)
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')

    return { value: text }
  })
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.stat', (_, e) => {
    if (e.path === '/work/themes' || e.path === '/work/talks') {
      return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false } }
    }
    if (!files.has(e.path)) throw new Error('ENOENT')

    return { value: { kind: 'file' as const, size: 1, mtimeMs, isLink: false } }
  })
  // grep, looking for decks: the folder the session is in has the one
  on('process.run', (_, e) => {
    const stdout = e.argv[0] === 'grep' && e.argv.at(-1) === '/work/talks' ? `${PATH}\n` : ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* (_, e, next) {
    const pending: (string | null)[] = []
    let wake = (): void => undefined
    const child: Child = {
      argv: [...e.argv],
      isAlive: true,
      log: text => (pending.push(text), wake()),
      exit: () => (pending.push(null), wake()),
    }
    children.push(child)
    // Ending the stream, or the module unloading, is how the engine kills a child
    next.signal.addEventListener('abort', () => ((child.isAlive = false), child.exit()))
    try {
      for (;;) {
        while (pending.length === 0) await new Promise<void>(resolve => (wake = resolve))
        const text = pending.shift()
        if (text === null || text === undefined) return { value: { code: 1, signal: null } }
        yield { stream: 'stderr' as const, text }
      }
    } finally {
      child.isAlive = false
    }
  })
  // Claude Code was started in the deck's own folder; the themes are one level above it
  on('session.root', () => ({ value: '/work/talks' }))
  on('session.cwd', () => ({ value: '/work/talks' }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  let isPaneOpen = true
  on('ui.panes', () => ({
    value: isPaneOpen
      ? [{ id: 'marp-preview', title: 'Marp Preview', isShown: true, isFocused: false, isPlaced: true, plugin: 'marp-preview' }]
      : [],
  }))

  const alive = () => children.filter(child => child.isAlive).length
  const last = () => children.at(-1)
  /** marp logs a conversion of `count` slides; the plugin takes it as over once the log goes quiet. */
  const renders = async (count: number) => {
    last()?.log('[  WARN ] Insecure local file accessing is enabled for conversion from deck.md.\n')
    for (let page = 1; page <= count; page++) last()?.log(`[  INFO ] deck.md => s.${String(page).padStart(3, '0')}.png\n`)
    await clock.advance(100)
  }

  const opened = await $.command.run({
    command: 'marp',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })
  await clock.advance(0)
  expect(JSON.stringify(opened)).toContain('deck.md')
  expect(children.length).toBe(1)
  expect(last()?.argv).toEqual(expect.arrayContaining(['--watch', '--images', 'png', '--theme-set', '/work/themes', PATH]))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const drawn = async () => JSON.stringify(await ui.drawn())
  expect(await ui.find({ type: 'Text', text: 'Rendering the deck…' })).toBeDefined()
  await renders(3)
  for (const name of ['s.001.png', 's.002.png', 's.003.png']) expect(await drawn()).toContain(name)

  // The test host has no pane scrolling: only check that a press does not break
  await ui.press({ key: 'end' })
  await ui.press({ key: 'start' })

  // Claude or an editor rewrites the third slide: the same marp renders it, and that slide is marked
  files.set(PATH, DECK.replace('# Three', '# Three, revised'))
  mtimeMs = 2
  await renders(3)
  expect(children.length).toBe(1)
  expect((await ui.find({ type: 'Text', text: '3 / 3' }))?.props.color).toBe('yellow')

  // A fourth slide is added: four are drawn
  files.set(PATH, `${files.get(PATH)}\n---\n\n# Four\n`)
  mtimeMs = 3
  await renders(4)
  expect(await drawn()).toContain('s.004.png')

  // Nothing changes for a long while: no restart, still the one marp
  await clock.advance(60_000)
  expect(children.length).toBe(1)
  expect(alive()).toBe(1)

  // marp dies: the next poll starts another, which renders the deck again
  last()?.exit()
  await clock.advance(1000)
  expect(children.length).toBe(2)
  expect(alive()).toBe(1)
  await renders(4)
  expect(await ui.find({ type: 'Text', text: 'Rendering…' })).toBeUndefined()

  // marp hangs: the deck is saved and nothing is rendered. It is killed and replaced
  mtimeMs = 4
  await clock.advance(7000)
  expect(children.length).toBe(2)
  await clock.advance(2000)
  expect(children.length).toBe(3)
  expect(alive()).toBe(1)
  await renders(4)

  // marp keeps dying before it renders anything: after the one that had rendered, three more
  // are tried, then the pane says so and waits
  for (let tries = 0; tries < 6; tries++) {
    last()?.log('[ ERROR ] Failed to launch the browser.\n')
    last()?.exit()
    await clock.advance(1000)
  }
  expect(children.length).toBe(6)
  expect(alive()).toBe(0)
  expect(await ui.find({ type: 'Text', text: /Failed to launch the browser/ })).toBeDefined()
  await clock.advance(30_000)
  expect(children.length).toBe(6)

  // The deck is saved again: that is the cue to try once more
  mtimeMs = 5
  await clock.advance(1000)
  expect(children.length).toBe(7)
  await renders(4)
  expect(alive()).toBe(1)

  // The pane is gone (the engine's own `ui.close` is not one a test can raise): within a poll
  // marp is stopped, and nothing starts it again
  isPaneOpen = false
  await clock.advance(1000)
  expect(alive()).toBe(0)
  mtimeMs = 6
  await clock.advance(30_000)
  expect(children.length).toBe(7)
  await ui.unmount()
})

test('the session ending stops marp; a /clear does not', async ($, on) => {
  const children: Child[] = []
  const clock = mock.clock(on)
  on('fs.read', () => ({ value: DECK }))
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false } }))
  on('process.spawn', async function* (_, e, next) {
    const child: Child = { argv: [...e.argv], isAlive: true, log: () => undefined, exit: () => undefined }
    children.push(child)
    try {
      await new Promise<void>(resolve => next.signal.addEventListener('abort', () => resolve()))

      return { value: { code: null, signal: 'SIGTERM' } }
    } finally {
      child.isAlive = false
    }
  })
  on('session.root', () => ({ value: '/work' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))

  await $.command.run({
    command: 'marp',
    args: PATH,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })
  await clock.advance(0)
  expect(children.filter(child => child.isAlive).length).toBe(1)

  const resume = { id: 'test' }
  await $.session.end({ reason: 'clear', sessionId: 'test', resume })
  await clock.advance(0)
  expect(children.filter(child => child.isAlive).length).toBe(1)

  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'test', resume })
  await clock.advance(0)
  expect(children.filter(child => child.isAlive).length).toBe(0)
})
