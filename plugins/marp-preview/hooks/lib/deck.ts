// Pure functions that read Marp Markdown one slide at a time.

export type Slide = {
  /** The first line of the slide's body (the rule is not part of it). */
  start: number
  /** The end of the slide's body, exclusive. */
  end: number
}

export type Parsed = { lines: string[]; slides: Slide[] }

const RULE = /^(---+|\*\*\*+|___+)\s*$/
const FENCE = /^\s*(```|~~~)/

/**
 * Whether a `---` right under `prev` splits slides. Under a paragraph it is a
 * setext heading and inside an HTML block it is plain text: neither splits.
 */
function breaksAfter(prev: string): boolean {
  const trimmed = prev.trim()
  if (trimmed === '') return true
  if (/^ {0,3}#{1,6}(\s|$)/.test(prev)) return true
  if (/^\s*([-*+]|\d+[.)])\s/.test(prev) || trimmed.startsWith('>')) return true

  return trimmed.endsWith('-->') || FENCE.test(prev) || RULE.test(prev)
}

export function parse(text: string): Parsed {
  const lines = text.split('\n')
  let first = 0
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((line, i) => i > 0 && line.trim() === '---')
    if (close > 0) first = close + 1
  }
  const slides: Slide[] = []
  let start = first
  let isFenced = false
  for (let i = first; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (FENCE.test(line)) isFenced = !isFenced
    if (isFenced || !RULE.test(line)) continue
    const isBreak = i === start || breaksAfter(lines[i - 1] ?? '')
    if (!isBreak) continue
    slides.push({ start, end: i })
    start = i + 1
  }
  slides.push({ start, end: lines.length })

  return { lines, slides }
}

/** One slide's Markdown, without its rule. */
export function slideText(parsed: Parsed, index: number): string {
  const slide = parsed.slides[index]

  return slide ? parsed.lines.slice(slide.start, slide.end).join('\n') : ''
}

/** The first slide an edit changed; undefined when none did. */
export function changedSlide(before: string, after: string): number | undefined {
  const was = parse(before)
  const now = parse(after)
  for (let i = 0; i < now.slides.length; i++) {
    if (slideText(was, i) !== slideText(now, i) || i >= was.slides.length) return i
  }

  return was.slides.length > now.slides.length ? now.slides.length - 1 : undefined
}

export function frontmatter(text: string, key: string): string {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return ''
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.trim() === '---') break
    const match = /^([\w-]+):\s*(.*)$/.exec(line)
    if (match?.[1] === key) return (match[2] ?? '').trim().replace(/^["']|["']$/g, '')
  }

  return ''
}

export function dirname(path: string): string {
  const cut = path.lastIndexOf('/')

  return cut <= 0 ? '/' : path.slice(0, cut)
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}
