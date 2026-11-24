# Cage Board

A cage management board for animal facilities, built as an [Obsidian](https://obsidian.md) plugin. Each cage is shown as a card with its properties, its mice, and its Timeline. Filter the board by what needs attention **today**, what is **overdue**, what is **upcoming**, or by **project**.

Works on desktop and mobile. Fully offline — no network requests, no telemetry.

> **Status:** early public release. The UI text is currently in Chinese, and the board reads a fixed set of vault conventions (see [Vault conventions](#vault-conventions)). Configurable paths and an English/i18n interface are planned.

## Features

- **One card per cage** — properties (purpose, project, strain, water, feed, …), a mouse table, and the cage Timeline.
- **Attention filters** — buttons under the search bar switch the board between:
  - **Today** — cages with an open task due today.
  - **Overdue** — cages with an open task whose due date has passed.
  - **Recent** — overdue cages plus cages with a task due within the next 7 days.
  - **By project** — pick a project to list every cage that belongs to it.
- **Search** — keyword search across selectable frontmatter fields, cage names, and mouse IDs.
- **Interactive Timeline** — tick a task checkbox to write the completion back to the note. With the [Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) plugin installed, completion dates and recurrence are handled by Tasks; otherwise a plain checkbox toggle is used.
- **Drag to link** — drag a cage title or mouse ID into a note to insert a wikilink; drag a project note onto a card's `project` field to assign it.
- **Hover preview** — hover any internal link to preview the note (requires the core **Page preview** plugin).

## Installation

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest [release](../../releases).
2. Create a folder `<your-vault>/.obsidian/plugins/cage-board/` and put the three files inside.
3. Reload Obsidian and enable **Cage Board** in *Settings → Community plugins*.

### Via BRAT (beta)

Add this repository with the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin to install and auto-update pre-release builds.

## Usage

- Open the board from the ribbon icon (container) or the command **Open cage board**.
- Use the filter buttons to narrow the board; click an active filter again to return to **All**.
- Type in the search box to filter by keyword; use the search-domain dropdown to choose which fields are searched.
- Click a card title to open the cage note; click a mouse ID to open the mouse note.
- Tick Timeline checkboxes to mark tasks done (writes back to the note).

### Settings

- **Data scope** — include offline cages; hide empty cages.
- **Layout** — group by rack, sort order, card density, columns per row.
- **Display columns** — choose which cage properties and mouse fields appear.
- **Timeline** — show open tasks only or all; per-card task limit; show dates.
- **Other** — auto-open the board on startup (off by default); auto-refresh on data change.

## Vault conventions

The board currently reads a fixed layout. Notes must follow these conventions to appear:

| Item | Convention |
| --- | --- |
| Cage notes | Folder `02_Areas/cages/`, frontmatter tag `cage`, file name `{position}-{YYMMDD}` (e.g. `C3G-261026`). |
| Mouse notes | Folder `02_Areas/mice/`, frontmatter tag `mouse`, a `cage` field linking the cage (e.g. `[[C3G-261026]]`). |
| Online status | Cage `status: 在线`; mouse `status: 在养`. |
| Timeline | A `## Timeline` section with task lines, e.g. `- [ ] weigh 📅 2026-11-24`. Due dates use `📅 YYYY-MM-DD`; completion uses `✅ YYYY-MM-DD`. |
| Grouping | Cages are grouped by the first character of the cage name (the rack letter). |

Cage properties read from frontmatter: `purpose`, `project`, `strain`, `water`, `feed`, `owner`, `special`, `note`, `experiment`. Mouse fields: `sex`, `dob`, `genotype`, `from`, `note`, `status`.

> These paths, tags, and status values are hardcoded in this release. Making them configurable is on the roadmap.

## Dependencies

- **[Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks)** (optional) — for recurrence-aware completion and completion dates. The board falls back to a plain checkbox toggle when Tasks is absent.
- **Page preview** (core plugin) — enable it in *Settings → Core plugins* for hover preview. Cage Board does **not** change this setting automatically.

## Platform notes

- Dragging a note **from within Obsidian** works on desktop and mobile.
- Dragging a file **from the OS file explorer** onto the `project` field uses a desktop-only API and is unavailable on mobile.

## Privacy

Cage Board runs entirely inside your vault. It makes no network requests and collects no telemetry.

## License

[MIT](./LICENSE) © caoqiuyu
