# Changelog

## 0.2.1

- Fixed slides drawn at different sizes after the pane was resized: a slide whose picture had not changed kept the size it was first drawn at. A resize now draws every slide again at the pane's size
- Changed `/marp` with no argument to close the pane when it is in view, stopping marp; with the pane closed it opens the deck as before. `/marp <deck>` and `/marp <folder>` still open

## 0.2.0

- Changed rendering to one long-running marp: `/marp` starts marp-cli in watch mode and leaves it running, so a save is rendered by the browser that is already open, in about a second and a half where starting a browser each time took four or five. The first render after `/marp` still takes a few seconds
- Added care of that marp: it is started again when it dies and replaced when it sits on a saved deck for eight seconds; after three starts in a row that render nothing the pane shows marp's error and waits for the deck's next save. It is stopped when the pane closes, the session ends (not on a `/clear`, which keeps the pane), another deck is opened or the plugin reloads
- Added `/marp <folder>`, which opens the most recently changed deck in that folder; `/marp` with no argument now looks under the folder the session is in before the rest of the project
- Fixed marp and the themes not being found when Claude Code is started in the deck's own folder: they are searched for up to six folders above the deck, past the session's root, so a marp installed a level or two up is used rather than `npx`
- Changed the scroll to a changed slide to land the slide mid-window, so its page number, the one marked in yellow, is no longer hidden above the top
- Added a demo to the README, and the deck it shows, `docs/demo/deck.md`

## 0.1.0

- Added `/marp [file]`: opens a pane with every slide of the deck rendered in one scrolling column; with no file it opens the most recently changed deck in the project
- Added buttons that jump to the last and the first slide
- Added following of the file: a save from Claude or an editor is rendered again within a second, and the pane scrolls to the first slide that changed
- Added tests of the deck logic and of the pane through `claude plugin test`, and CI that runs them, validates the marketplace and the plugin, and type-checks on every push, pull request and weekly against the latest Claude Code
