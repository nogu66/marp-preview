import { changedSlide, frontmatter, parse, slideText } from "../plugins/marp-preview/hooks/lib/deck"

const DECK = [
  "---",
  "marp: true",
  "theme: brand",
  "---",
  "",
  "<!-- _class: lead -->",
  "",
  "# Title",
  "",
  "---",
  "",
  "# Two",
  "",
  "- apple",
  "",
  "```",
  "---",
  "```",
  "",
  "---",
  "",
  "# Three",
  "",
].join("\n")

const count = (text: string) => parse(text).slides.length

describe("parse", () => {
  test("front matter and a --- inside a code fence do not split slides", () => {
    expect(count(DECK)).toBe(3)
    expect(slideText(parse(DECK), 1)).toContain("```\n---\n```")
    expect(frontmatter(DECK, "theme")).toBe("brand")
  })

  test("a --- right under a heading, a list, a quote or a comment is a break, as in Marp", () => {
    expect(count("# a\n---\n# b")).toBe(2)
    expect(count("- a\n---\n# b")).toBe(2)
    expect(count("> a\n---\n# b")).toBe(2)
    expect(count("<!-- note -->\n---\n# b")).toBe(2)
    expect(count("```\ncode\n```\n---\n# b")).toBe(2)
  })

  test("a --- right under a paragraph is a setext heading, and inside an HTML block it is text", () => {
    expect(count("Title\n---\n\nbody")).toBe(1)
    expect(count("<div>\n---\n</div>\n\nbody")).toBe(1)
  })
})

describe("changedSlide", () => {
  test("names the first slide whose text changed", () => {
    expect(changedSlide(DECK, DECK)).toBeUndefined()
    expect(changedSlide(DECK, DECK.replace("apple", "orange"))).toBe(1)
    expect(changedSlide(DECK, DECK.replace("# Three", "# 3"))).toBe(2)
  })

  test("a slide added at the end is the changed one, and a removed last slide shows the new last", () => {
    expect(changedSlide(DECK, `${DECK}\n---\n\n# Four\n`)).toBe(3)
    expect(changedSlide(DECK, DECK.slice(0, DECK.indexOf("\n---\n\n# Three")))).toBe(1)
  })
})
