---
marp: true
theme: default
paginate: true
style: |
  section {
    background: #faf9f5;
    color: #141413;
    font-family: 'Helvetica Neue', 'Hiragino Sans', sans-serif;
    padding: 70px 90px;
    font-size: 44px;
    justify-content: center;
  }
  h1 { color: #05429a; font-size: 84px; }
  h2 { color: #05429a; font-size: 76px; margin-bottom: 0.5em; }
  strong { color: #d97757; }
  code { background: #e8e6dc; color: #141413; border-radius: 8px; padding: 2px 10px; }
  pre { background: #141413; border-radius: 16px; font-size: 38px; padding: 0.7em 1em; }
  pre code { background: none; color: #faf9f5; }
  section.lead { background: #05429a; color: #faf9f5; justify-content: center; text-align: center; }
  section.lead h1 { color: #faf9f5; font-size: 130px; margin-bottom: 0.2em; }
  section.lead strong { color: #f0b9a4; }
  section.dark { background: #141413; color: #faf9f5; }
  section.dark h2 { color: #6a9bcc; }
  section::after { color: #b0aea5; }
---

<!-- _class: lead -->
<!-- _paginate: false -->

# marp-preview

Your Marp deck, **live** in a Claude Code pane

---

## One command

```
/marp
```

Every slide of the deck, rendered, in one scrolling column.

---

## It follows the file

Ask Claude to change a slide.

The pane renders it again and **scrolls to the slide that changed**.

---

## Quarterly results

- Revenue: *to be written*
- Growth: *to be written*

---

<!-- _class: dark -->

## Install

```
claude plugin marketplace add \
  nogu66/marp-preview
claude plugin install \
  marp-preview@marp-preview
```
