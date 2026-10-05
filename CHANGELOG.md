# Changelog

## 0.1.0

- Added `/marp [file]`: opens a pane with every slide of the deck rendered in one scrolling column; with no file it opens the most recently changed deck under the folder the session is in, and a folder stands for the newest deck in it
- Added buttons that jump to the last and the first slide
- Added following of the file: a save from Claude or an editor is rendered again within a second, and the pane scrolls to the first slide that changed
- Added tests of the deck logic and of the pane through `claude plugin test`, and CI that runs them, validates the marketplace and the plugin, and type-checks on every push, pull request and weekly against the latest Claude Code
