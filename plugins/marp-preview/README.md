# marp-preview

A live Marp slide preview in a Claude Code pane: every slide rendered in one scrolling column, re-rendered on save and scrolled to the slide Claude or your editor just changed.

Usage, requirements and troubleshooting: [github.com/nogu66/marp-preview](https://github.com/nogu66/marp-preview#readme).

## What the hooks do

The plugin is one hooks module, `hooks/register.tsx`:

| Hook | What it does |
| --- | --- |
| `session.start` | Registers the `/marp` command, and resumes following the deck if the pane is still open after a reload |
| `command.run` (`/marp`) | Finds or takes the deck, opens the pane and starts the first render |
| `ui.render` (the pane) | Draws every slide's image in one column, which the pane scrolls |
| `ui.close` | Stops following the deck when the pane closes |

## What it touches

- **Files it reads:** the deck you open, and its modification time once a second while the pane is open. To find a deck when `/marp` has no argument it runs `grep` for `marp: true` over the `.md` files of the project.
- **Files it writes:** none in the project. It never changes the deck.
- **Processes it runs:** `marp` (from the project's `node_modules`, else `npx --yes @marp-team/marp-cli`) with `--images png --allow-local-files`, writing PNGs under `/tmp/marp-preview/`; `mkdir -p` for that folder; and the `grep` above.
- **Not touched:** the network (beyond what `npx` does to fetch marp-cli), the model, tool calls, the prompt, and settings.
- **Environment variables:** none.
