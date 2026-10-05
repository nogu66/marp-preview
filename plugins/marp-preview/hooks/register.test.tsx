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

test('/marp renders every slide in one scrolling column, and an outside edit scrolls to the changed slide', async ($, on) => {
  const files = new Map([[PATH, DECK]])
  const runs: string[][] = []
  let mtimeMs = 1
  const clock = mock.clock(on)
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')

    return { value: text }
  })
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.stat', (_, e) => {
    if (e.path === '/work/themes' || e.path === '/work/talks') return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false } }
    if (!files.has(e.path)) throw new Error('ENOENT')

    return { value: { kind: 'file' as const, size: 1, mtimeMs, isLink: false } }
  })
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    // grep, looking for decks: this folder has the one
    const stdout = e.argv[0] === 'grep' && e.argv.at(-1) === '/work/talks' ? `${PATH}\n` : ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // Claude Code was started in the deck's own folder; the themes are one level above it
  on('session.root', () => ({ value: '/work/talks' }))
  on('session.cwd', () => ({ value: '/work/talks' }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.panes', () => ({ value: [] }))

  const opened = await $.command.run({
    command: 'marp',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })
  await clock.advance(0)
  expect(JSON.stringify(opened)).toContain('deck.md')
  const renders = () => runs.filter(argv => argv.includes('--images')).length
  expect(runs.find(argv => argv.includes('--images'))).toEqual(expect.arrayContaining(['--theme-set', '/work/themes', PATH]))
  expect(renders()).toBe(1)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const image = async () => JSON.stringify(await ui.drawn())
  for (const name of ['s.001.png', 's.002.png', 's.003.png']) expect(await image()).toContain(name)
  expect(await ui.find({ type: 'Text', text: '3 / 3' })).toBeDefined()

  // The test host has no pane scrolling: only check that a press does not break
  await ui.press({ key: 'end' })
  await ui.press({ key: 'start' })

  // Claude or an editor rewrites the third slide: rendered again, and that slide is marked
  files.set(PATH, DECK.replace('# Three', '# Three, revised'))
  mtimeMs = 2
  await clock.advance(1000)
  expect(renders()).toBe(2)
  expect((await ui.find({ type: 'Text', text: '3 / 3' }))?.props.color).toBe('yellow')

  // A fourth slide is added: four are drawn
  files.set(PATH, `${files.get(PATH)}\n---\n\n# Four\n`)
  mtimeMs = 3
  await clock.advance(1000)
  expect(renders()).toBe(3)
  expect(await image()).toContain('s.004.png')

  // No change, no render
  await clock.advance(3000)
  expect(renders()).toBe(3)
  await ui.unmount()

  // Off the terminal there is no image to draw: the pane says so instead of drawing empty boxes
  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await desktop.find({ type: 'Text', text: /kitty graphics protocol/ })).toBeDefined()
  expect((await desktop.findAll({ type: 'Text', text: /^\d+ \/ \d+$/ })).length).toBe(0)
  await desktop.unmount()
})
