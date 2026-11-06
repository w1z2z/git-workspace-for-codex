# Changelog

Заметки о значимых изменениях Git Workspace. Версии соответствуют тегам Git и релизам GitHub.

## [1.7.11] - 2026-11-07

### Added

- Commit history with a visual graph, local branch filtering, an all branches view, and incremental loading. Select a commit to see its changed files and review their diffs.
- Repository cards showing the active branch and changed file count for quick switching between multiple repositories.

### Changed

- Redesigned the plugin interface for repository navigation, the Changes view, diff review, and commit composition.
- Improved diff readability with clearer line context and change navigation.
- Made the full file row clickable, including line counts, and moved the Open File button into the diff toolbar.
- Added a draggable divider for wide panels and separate file list and diff views for narrow panels.

### Fixed

- The divider highlight clears after dragging when the pointer leaves it.
- The diff overview no longer draws a viewport outline when the content fits without scrolling.
