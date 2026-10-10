---
name: Postgres Studio
description: A dense, IDE-grade PostgreSQL client where the data is the widest, clearest thing on screen.
colors:
  accent: "#3574F0"
  accent-hover-dark: "#4682FA"
  accent-hover-light: "#2A63D6"
  accent-text-dark: "#6B9BFA"
  accent-text-light: "#2A63D6"
  on-accent: "#FFFFFF"
  seam-dark: "#1A1B1E"
  editor-dark: "#1E1F22"
  row-hover-dark: "#26282C"
  panel-dark: "#2B2D30"
  line-soft-dark: "#2F3135"
  line-dark: "#393B40"
  field-line-dark: "#4E5157"
  sel-soft-dark: "#25324A"
  sel-dark: "#2E436E"
  text-3-dark: "#959AA2"
  text-2-dark: "#B4B8BF"
  text-dark: "#DFE1E5"
  editor-light: "#FFFFFF"
  panel-light: "#F7F8FA"
  row-hover-light: "#F4F6FA"
  line-soft-light: "#EFF0F3"
  hover-light: "#E9EBEF"
  line-light: "#E4E6EB"
  field-line-light: "#C9CCD6"
  sel-soft-light: "#E8EEFD"
  sel-light: "#D5E1FF"
  text-3-light: "#6B6F7C"
  text-2-light: "#4F5361"
  text-light: "#1E1F22"
  ok-dark: "#5FB865"
  warn-dark: "#E2B45C"
  danger-dark: "#E5675F"
  ok-light: "#3F8F46"
  warn-light: "#A36B00"
  danger-light: "#C9372C"
  json-key-dark: "#C77DBB"
  json-string-dark: "#6AAB73"
  json-number-dark: "#2AACB8"
  json-keyword-dark: "#CF8E6D"
  json-bson-dark: "#56A8F5"
  json-punct-dark: "#8C8F96"
  code-comment-dark: "#7A7E85"
  json-key-light: "#871094"
  json-string-light: "#067D17"
  json-number-light: "#1750EB"
  json-keyword-light: "#0033B3"
  json-bson-light: "#00627A"
  json-punct-light: "#6E7180"
  code-comment-light: "#8C8C8C"
  conn-green: "#4FA25A"
  conn-blue: "#3574F0"
  conn-amber: "#C9912C"
  conn-red: "#D6453D"
  conn-magenta: "#B4448F"
  conn-teal: "#1E9AA6"
  conn-violet: "#7B61D1"
  conn-slate: "#6E7380"
typography:
  display:
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.3
  title:
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.45
  body:
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: "\"cv11\", \"ss01\""
  label:
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.45
  caption:
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.45
  data:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: "20px"
    fontFeature: "\"liga\" 0, \"tnum\""
  code:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "20px"
rounded:
  xs: "3px"
  sm: "4px"
  md: "6px"
  overlay: "8px"
  lg: "10px"
spacing:
  xxs: "2px"
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  xxl: "24px"
  row: "24px"
  control: "28px"
  field: "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "28px"
  button-primary-hover-dark:
    backgroundColor: "{colors.accent-hover-dark}"
  button-primary-hover-light:
    backgroundColor: "{colors.accent-hover-light}"
  button-secondary:
    textColor: "{colors.text-dark}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "28px"
  button-ghost:
    textColor: "{colors.text-2-dark}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "28px"
  toolbar-icon-button:
    textColor: "{colors.text-2-dark}"
    rounded: "{rounded.md}"
    size: "28px"
  input-dark:
    backgroundColor: "{colors.editor-dark}"
    textColor: "{colors.text-dark}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "32px"
  input-light:
    backgroundColor: "{colors.editor-light}"
    textColor: "{colors.text-light}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "32px"
  query-field:
    typography: "{typography.data}"
    rounded: "{rounded.md}"
    height: "30px"
  tree-row:
    typography: "{typography.body}"
    height: "{spacing.row}"
  tree-row-selected-dark:
    backgroundColor: "{colors.sel-dark}"
  tree-row-selected-light:
    backgroundColor: "{colors.sel-light}"
  grid-cell:
    typography: "{typography.data}"
    padding: "0 10px"
    height: "{spacing.row}"
  grid-row-selected-dark:
    backgroundColor: "{colors.sel-soft-dark}"
  grid-row-selected-light:
    backgroundColor: "{colors.sel-soft-light}"
  grid-header-dark:
    backgroundColor: "{colors.panel-dark}"
    typography: "{typography.label}"
    height: "30px"
  editor-tab:
    textColor: "{colors.text-2-dark}"
    padding: "0 6px 0 12px"
    height: "36px"
  segmented-control:
    rounded: "{rounded.md}"
    padding: "2px"
    height: "28px"
  menu:
    backgroundColor: "{colors.panel-dark}"
    rounded: "{rounded.overlay}"
    padding: "4px"
  menu-item-hover:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    height: "28px"
  status-bar-dark:
    backgroundColor: "{colors.panel-dark}"
    textColor: "{colors.text-2-dark}"
    typography: "{typography.caption}"
    height: "26px"
  dialog:
    backgroundColor: "{colors.editor-dark}"
    rounded: "{rounded.lg}"
  connection-chip:
    rounded: "{rounded.sm}"
    size: "18px"
---

<!-- The app's design system, recorded 2026-09-26 from the approved redesign mockup and implemented in the app: tokens in src/index.css (both themes under the same names), interface primitives in src/components/ui (shadcn/ui on Radix, restyled to these tokens). -->

# Design System: Postgres Studio

## Overview

**Creative North Star: "The Data IDE"**

Postgres Studio is played straight as a category-standard developer tool, at the finish level of JetBrains New UI, VS Code and Linear. The world is dense, quiet and exact: 13px Inter chrome, JetBrains Mono for every piece of data, 24px rows, 16px line icons, and a neutral stack of near-blacks (or near-whites) separated by hairline rules. Chrome recedes so the data grid and the typed row inspector become the widest, clearest things on screen.

The one loud signal is place. Every surface says which server, database and table it runs against: the toolbar's connection widget, the breadcrumb, the tab label (`name` plus connection in a quieter tone), the tab underline and the status bar all carry the connection. Color is spent on that identity, on a single blue for selection and primary action, on run green, and on syntax color for data values; everything else is grey.

The system has exactly two themes, dark and light, built as twins: same structure, same token names, different values. They supersede the editor-style theme set in the current app.

**Key Characteristics:**
- IDE density: 24px data and tree rows, 28px controls, 36px tab and panel bars, 26px status bar.
- Two type voices: Inter for interface, JetBrains Mono (ligatures off, tabular figures) for all data, queries and code.
- Tonal layering, not shadows: editor, panel and seam tones plus 1px rules build the window; shadows exist only on floating layers.
- One blue accent (#3574F0) in both themes; syntax colors carry value types.
- Connection identity is color-coded and repeated on every surface that runs against it.
- Motion on state only, 140-200ms ease-out, nothing on load.

## Colors

A JetBrains-derived neutral stack in two twin themes, one blue accent, three status hues, a syntax palette for typed data, and an eight-swatch connection palette.

### Primary
- **Selection Blue** (accent): primary buttons, focus outline and field focus ring, active tool-stripe marker, console output tab underline, menu item hover fill, index usage bars, resizer drag line. Identical in both themes. Hover deepens in light (accent-hover-light) and lifts in dark (accent-hover-dark).
- **Link Blue** (accent-text-dark / accent-text-light): the accent used as text on neutral grounds, e.g. welcome action icons, palette match highlight, retry links. Lighter in dark so it holds contrast.
- **Selection Fill** (sel-dark / sel-light): selected tree node, selected dialog nav item, selected palette item, text selection. The softer **Selection Tint** (sel-soft-*) marks the selected grid row, so the grid never shouts.

### Secondary
- **Run Green / OK** (ok-dark / ok-light): the live-connection dot, successful test result, toast check, the green flash after an in-place edit saves.
- **Unsaved Amber** (warn-dark / warn-light): the dirty dot on an unsaved script file.
- **Error Red** (danger-dark / danger-light): connection errors in the tree, destructive menu items (hover fills red with white text).

### Tertiary: data syntax
- **Key Orchid** (json-key-*): keys in the inspector's json values and code properties.
- **String Green** (json-string-*), **Number Cyan / Blue** (json-number-*), **Keyword Clay / Navy** (json-keyword-*, booleans and JS keywords), **Type Blue / Teal** (json-bson-*, dates, uuids, json and the other typed values; the token keeps its old name), **Punctuation Grey** (json-punct-*), **Comment Grey** (code-comment-*, italic). In the grid, plain strings stay in body text color; only numbers, keywords, typed values and null (faint italic) are colored.

### Connection palette
- Eight swatches, in picker order: **Green** (conn-green), **Blue** (conn-blue), **Amber** (conn-amber), **Red** (conn-red), **Magenta** (conn-magenta), **Teal** (conn-teal), **Violet** (conn-violet), **Slate** (conn-slate). A connection's color fills its initials chip, draws the active tab's 2px underline, tints the toolbar's leading edge (26% mixed into the panel tone, fading out by 360px), and marks the status bar. Mockup copy states the purpose: production never looks like local.

### Neutral
- **Editor** (editor-*): the main work surface: tabs row, grid body, inspector, console, dialogs.
- **Panel** (panel-*): tool windows and chrome: toolbar, tool stripe, explorer, grid and table headers, status bar, dialog nav.
- **Seam** (seam-*): the 1px rule between chrome regions (toolbar bottom, stripe and panel right, status bar top).
- **Line** (line-*) and **Line Soft** (line-soft-*): rules inside the editor: tab bar and query bar bottoms, grid cell rules (soft), inspector sections (soft), overlay borders.
- **Field Line** (field-line-*): input and secondary-button strokes; switch track off.
- **Row Hover** (row-hover-*) and **Hover** (hover-light; in dark the hover tone equals line-dark): row hover and control hover respectively.
- **Text / Text 2 / Text 3** (text-*, text-2-*, text-3-*): primary text, secondary text (inactive tabs, labels, status bar), faint text (types, counts, placeholders, gutters).

### Named Rules
**The One Blue Rule.** The accent is the only interface hue. It marks selection, focus and the single primary action per bar; it is never decoration.

**The Connection Owns Its Color Rule.** Connection colors appear only where they identify a connection (chip, tab underline, toolbar edge, status bar). They are never reused for status, types or emphasis, and status colors are never offered as a connection's only cue.

**The Twin Themes Rule.** Every token exists in both themes under the same name; a surface built in one theme must be correct in the other with no per-theme structure.

## Typography

**Interface Font:** Inter (with system-ui, -apple-system, Segoe UI, sans-serif), stylistic sets cv11 and ss01 on, weights 400-600, embedded.
**Data / Code Font:** JetBrains Mono (with ui-monospace, SF Mono, Menlo, Consolas, monospace), weights 400-500, ligatures off, tabular numerals, embedded.

**Character:** A neutral, compact sans for the tool and a legible developer mono for the data, exactly the JetBrains pairing. The split is by content, not by emphasis: anything the user typed or stored is mono; anything the app says is Inter.

### Hierarchy
- **Display** (600, 22px, -0.01em): the welcome screen app name only.
- **Headline** (600, 15px): dialog titles.
- **Title** (600, 13px): panel headers (Explorer), inspector header, welcome group headings at 12px.
- **Body** (400, 13px, 1.45): all chrome text: tree, tabs, menus, buttons, forms.
- **Label** (500, 12px): form field labels, grid column headers, results summary, status items at 11px.
- **Caption** (400, 11px): counts, help text, status bar, tree metadata, key hints.
- **Data** (400, 12.5px mono, 20px line): grid cells, inspector tree, query fields, JSON view, logs, connection strings.
- **Code** (400, 13px mono, 20px line): the console editor.
- **Type tags** (mono 10.5px in grid headers; Inter 10px in the inspector): the faint type beside each column (text, int8, timestamptz, jsonb).
- **Keycaps** (500, 10.5px Inter): shortcut hints, 1px border with a 2px bottom border.

### Named Rules
**The Data Is Mono Rule.** Values, column names, conditions, SQL, URIs, qualified names and script names are always JetBrains Mono with ligatures off; chrome is never mono.

**The Four Sizes Rule.** Chrome lives on 13 / 12 / 11px. Larger sizes are reserved for the welcome title and dialog titles.

## Layout

A fixed IDE frame. Top: a 40px main toolbar in three columns (connection widget and breadcrumb left, centered search/quick-open field up to 320px, actions and window controls right). Left: a 40px tool stripe of 30px icon buttons, then a resizable side panel (280px default) holding the Explorer tree or saved scripts. Center: a 36px editor tab row, a 36px per-tab toolbar (Data / Structure / SQL segmented switch plus Refresh and Export), an 8px-padded query bar, a 34px results header, then the results split. Right of the grid: a resizable inspector (380px default, 320px under 1180px). Right of the editor, when open: the Assistant tool window (380px default, 320-640px, resizable from its left edge), docked while the editor keeps at least 520px and floating over it with the overlay shadow otherwise. Bottom: a 26px status bar.

Rhythm is a 2-4-6-8-12-16-24 scale; bars use 6-12px horizontal padding, dialogs 18-22px. Tree indentation steps 16px per depth with faint vertical guides in the inspector. The grid keeps its row-number column and header sticky, and fades its right edge (36px mask) where it meets the inspector.

Responsive: the editor adapts to its own width, not the window's - with the Assistant open the inspector stacks under the grid below 780px of grid width, the filter takes its own row below 820px of query bar, and the console toolbar sheds its labels and layout switch. Under 960px the side panel becomes an overlay over the editor, the inspector stacks under the grid at 45% height, the breadcrumb hides and the console stacks vertically. Under 640px the search collapses to an icon, window controls hide, the filter field takes a full row, the dialog nav becomes a horizontal strip and form rows go single column.

### Named Rules
**The Data Is Widest Rule.** The grid and inspector own the center; chrome widths are fixed and small, and nothing decorative competes for horizontal space.

**The Always Show Where Rule.** Connection, database and table are visible in the toolbar, the tab and the status bar at all times; a surface that runs a query or script shows its target beside its Run control.

## Elevation & Depth

Flat, tonal and ruled. The resting window is built from three neutral tones (editor, panel, seam) and 1px rules; no resting surface has a shadow. Shadows belong only to layers that float above the window: menus, the quick-open palette, dialogs, toasts, and the side panel when it overlays on narrow screens. Scrims dim the window behind modal dialogs (42% black in dark, 28% ink in light).

### Shadow Vocabulary
- **Overlay** (dark `0 12px 32px rgba(0,0,0,.45), 0 2px 6px rgba(0,0,0,.3)`; light `0 12px 32px rgba(20,24,35,.16), 0 2px 6px rgba(20,24,35,.08)`): menus, palette, dialogs, toasts, overlaid side panel.
- **Segment lift** (`0 1px 2px rgba(0,0,0,.25), 0 0 0 1px` line; light uses rgba(20,24,35,.12)): the pressed segment in a segmented control.
- **Focus ring** (`0 0 0 2px` accent at 30%): focused fields; keyboard focus elsewhere is a 2px accent outline.

### Named Rules
**The Flat Window Rule.** Nothing inside the window casts a shadow at rest. Depth inside the window is tone and rule; shadow means "floating above".

## Shapes

Gentle, small, consistent corners on a rectilinear frame. Controls, fields, buttons and nav items round at 6px; small chips, tags, keycaps, pager and row-action buttons at 4px; inline edit fields and value highlights at 3px; menus and toasts at 8px; dialogs, the palette and the window at 10px. Status dots and the live indicator are circles; underline indicators (active tab, active output tab, tool-stripe marker) are 2px bars with rounded ends. The grid, tree and panels themselves are square and edge-to-edge; borders are always 1px hairlines.

## Components

### Buttons
Compact, quiet and rectangular; only the primary speaks.
- **Shape:** gently rounded (6px), 28px tall, 10px side padding, 6px icon gap, 16px line icon.
- **Primary:** accent fill, white text at 500 weight; carries its keycap hint in translucent white. One per bar (Run, Save and connect).
- **Secondary:** transparent with a field-line stroke and body text (Explain, Save, Test connection).
- **Ghost:** no stroke, secondary text (Explain, Export CSV, Cancel); hover raises to text color on the hover tone.
- **Icon buttons:** 28px square in the toolbar, 30px in the tool stripe, 20-24px for row and pager actions; secondary text, hover tone on hover.
- **Hover / Focus:** hover swaps to the hover tone (primary to accent-hover); focus is a 2px accent outline; disabled drops to 45% opacity.

### Segmented control
- A 6%-text-tint track with 2px padding; 24px segments. The pressed segment takes the editor tone, text color and the segment lift. Used for view switches (Data / Structure / SQL, transaction mode, connect-with method).

### Inputs / Fields
- **Style:** field tone, 1px field-line stroke, 6px radius; 28px in panels, 30px in the query bar, 32px in forms. Query fields carry a lowercase 11px faint label inside the field (where, order by, limit, offset) and mono content; numeric fields right-align.
- **Focus:** stroke turns accent plus a 2px 30%-accent ring.
- **Parsed chips:** under a connection string, 22px tinted chips show parsed parts (hosts, user, auth source, TLS) with mono values.
- **Switch:** 30 x 18 track, field-line off, accent on, 150ms slide.

### Navigation
- **Tool stripe:** icon-only, pressed button takes the hover tone plus a 2px accent bar on its left edge.
- **Explorer tree:** 24px rows, 16px disclosure chevrons that rotate 90 degrees in 150ms, kind icons in secondary text, trailing faint counts and a row menu revealed on hover. Connections show their initials chip, a live dot when connected, or an inline error with retry.
- **Editor tabs:** 36px, icon + `name` + connection name in 12px faint text, close button visible on hover or when active, dirty dot for unsaved scripts. The active tab gets text color and a 2px underline in its connection's color (connections without a chosen color get a stable automatic one).
- **Tab groups:** a 24px chip at the head of each group: a connection group's is tinted with 15% of its connection color (24% on hover) and carries its initials chip; a group the user made is neutral (fg-3 tint, stack icon), since connection colors only ever name a connection. A 2px line at 42% of the tint runs under the group's tabs, under the active tab's own underline. Collapsed, the chip shows the tab count in a pill and the numbers of the panes its tabs are in. Tabs in a connection group drop the connection name.
- **Split panes:** up to four, separated by 1px line-tone gaps. Each has a 30px panel-tone header: pane number badge (16px, mono 10px; filled blue on the focused pane), connection chip, name, connection in faint text, maximize and close. The focused pane's header carries a 2px accent top edge - the only mark of focus. Tabs shown in a pane carry its number badge. An empty pane centers a short how-to and up to five open tabs to put in it. While a tab is dragged, the pane under the pointer takes a 12% accent wash with a 2px inset ring; a single view offers its right half, dashed-edged, to split.
- **Breadcrumb:** connection widget > database > schema > table as toolbar buttons, last crumb in text color.
- **Status bar:** 26px panel-tone strip, 11px secondary text; connection name in text color at 500, server version, connected count on the left; qualified table name (mono), row count and timing on the right.

### Data grid (signature)
Each header shows the column name (Inter 12px/500) and its type in faint mono, with a key icon on primary and foreign key columns. Mono 12.5px cells, 24px rows, soft cell rules, sticky row numbers and header, tabular figures. Hover takes row-hover; the selected row takes the selection tint. Double-clicking a cell edits in place: the cell gets a 2px inset accent ring and a type-aware input; Enter saves (green flash, 1.2s), Esc cancels. A changed cell keeps a warn tint until Commit; foreign key cells carry a link arrow that opens the referenced row. In a pane too narrow for the inspector, the inspector stacks under the grid.

### Inspector (signature)
The selected row as typed column/value pairs beside the grid: mono column names, values in syntax color, a faint type tag right-aligned per row, json values pretty-printed, then the row's references and the tables that reference it. Editable values show a hairline box on hover and edit in place with a 2px accent ring. A footer states the edit shortcuts with keycaps.

### Assistant
A tool window in the panel tone, docked right: a 36px head (title; sessions, new session, more, close as 28px icon buttons), a context row (connection chip, `db.schema.table` in mono, "on <connection>", a faint lock "Read-only" at the right), then the transcript and the composer.
- **Transcript:** the user's message on a 7% text tint, 6px radius; the agent's turn under a 10.5px faint agent name, as prose (13px, 1.55 line, inline code on an 8% tint), tool steps and cards in arrival order.
- **Tool steps:** 24px rows - a green check (a spinner while running, a faint circled x when denied, red when failed), the label, faint metadata, a chevron that expands the call as made in an 11.5px mono box on the editor tone.
- **Proposal card:** editor tone, 1px line, 6px radius: a 32px head (kind icon, bold kind, the connection's dot and `where on <connection>`, console and copy icon buttons), a warning row on a 9% warn tint when a script writes, the code at 12px mono on the syntax palette (250px max, scrolling), and a foot with the read-only dry run (green check, "Dry run: 10 rows · 6 ms") and the one primary with its Ctrl ⏎ keycap; once used it reads "Applied" in green with Undo.
- **Permission card:** the same card, an eye icon in link blue, what would be read and where the values go, then Allow once (primary) / Always on <connection> / Deny.
- **Composer:** an 8px-radius field-tone box with the focus ring: a two-line textarea, then 22px context chips (the session's table in mono, attached items removable), "Add context", the agent picker ("Claude Code · Sonnet", the model in faint text; its menu switches agent and model) and a 26px square send button (accent; a neutral square stop while running).
- **Setup:** the same window: an intro, the privacy note on a 5% tint above the fold, agent radio cards (accent border and 8% accent fill when chosen, path in mono, a green dot when found), a Model select ("Default · <the CLI's own>", the listed models with a faint one-line description, "Other model…" opening a mono name field) beside a 128px Effort select, switches for what it reads, a checkbox list of connections with their chips, how it stays read-only, and Not now / Start with <agent>.
- **Inline ask (Ctrl+I):** a strip under the query bar or console toolbar: a field ringed in accent with a link-blue sparkle and the agent's name, Generate / Cancel with keycaps; while working, a spinner and the step in progress; in review, the proposal in place - the filter field bordered green with the change on a 22% green tint, added console lines on a 14% green tint with a green "+" in the gutter - with Continue in Assistant, Reject Esc and Accept ⏎ as the bar's only primary (Run stands down meanwhile).
- **Marks:** a sparkle (Lucide `Sparkles`) means the Assistant and nothing else: the toolbar toggle, the ask buttons, the strips, the status bar item and the "from Assistant" tag (accent at 12% behind link-blue text) on a query or console the Assistant wrote. A field it just wrote flashes a green ring for 1.2s.

### Menus, palette, toasts
- **Context menu:** raised tone, 1px line border, 8px radius, 4px padding, overlay shadow; 28px items with icon and trailing keycap text; hover and keyboard focus fill with accent and white text; destructive items in red, filling red on hover; section heads in 11px faint text. Opens with a 140ms pop.
- **Quick open (Ctrl+K):** a 600px palette 72px from the top, 46px 14px input, 32px items grouped under 11px faint group names, match characters in link blue at 600, selected item on the selection fill.
- **Toast:** bottom-right, raised tone, 8px radius, green check icon, 11px secondary line.

### Dialog
Two-column modal (196px nav in panel tone, form on editor tone) with a 48px header, 56px footer, 10px radius and overlay shadow. The nav shows sections (General, TLS, SSH tunnel, Advanced) with their on/off state as faint trailing text; the selected section takes the selection fill. The footer holds Test connection on the left and Cancel / Save / Save and connect on the right. The connection-color swatch row uses 22px swatches, the pressed one ringed with an editor-tone gap; choosing none keeps the automatic color.

## Do's and Don'ts

### Do:
- **Do** set every data value, query, URI and namespace in JetBrains Mono at 12.5px with ligatures off and tabular figures.
- **Do** keep rows at 24px and controls at 28px; density is the point.
- **Do** build depth with the editor / panel / seam tones and 1px rules; reserve the overlay shadow for floating layers.
- **Do** show connection, database and table in the toolbar, tab and status bar of every surface, and the target beside every Run.
- **Do** keep one primary (accent-filled) action per bar.
- **Do** define every new token in both the dark and the light theme under the same name.
- **Do** animate only state changes (panel fill, disclosure, menu, dialog, toast) at 140-200ms with the ease-out curve, and honor reduced motion.

### Don't:
- **Don't** reintroduce per-editor themes (Monokai, Dracula, Solarized and the like); the identity is one dark and one light version.
- **Don't** use the accent or a connection color as decoration, and don't reuse connection colors for status or types.
- **Don't** set chrome in mono or data in Inter.
- **Don't** add shadows to resting surfaces inside the window.
- **Don't** animate anything on load.

## Implementation

- **Tokens** live in `src/index.css`: design names (`bg-editor`, `bg-panel`, `border-line`, `text-fg-2`, `text-json-key`, ...) plus shadcn/ui's names mapped onto them (`bg-primary` is the accent). A new token is added to both themes.
- **Type scale** in Tailwind: `text-base` 13px, `text-sm` 12px, `text-xs` 11px, `text-2xs` 10.5px, `text-lg` 15px, `text-xl` 22px; `font-data` is the 12.5px JetBrains Mono data style. The root stays 16px (Tailwind spacing is rem-based); the 13px base is set on `body`.
- **Primitives** come from `src/components/ui` (shadcn/ui on Radix): `Button` (primary / secondary / ghost / destructive), `Input`, `Select`, `Switch`, `Checkbox`, `Dialog` (header / body / footer), `DropdownMenu`, `ContextMenu`, `Tooltip`, `Command`, `SegmentedControl`, `Kbd`, `ConnectionChip`, and `sonner` for toasts. Screens compose these rather than styling their own controls; `cn()` in `src/lib/utils` merges classes.
- **Menus**: `RowContextMenu` and `ActionMenuButton` (`src/components/common/ActionMenu`) render one list of actions as both the right-click menu and the "..." menu.
- **Large results**: the data grid windows its rows past 100 rows (`useVirtualRows`); keep row heights uniform so the windowing stays exact.
- **Assistant**: `src/components/assistant` (panel, setup, cards, steps, inline strip) over `src/store/assistantStore` (settings persisted, sessions, events from the backend) and `src/lib/assistant` (answer parsing, diffs, the proposal highlighter). The panel loads on first open (`AssistantHost`).

