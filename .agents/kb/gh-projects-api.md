# kb — GH Projects (v2) GraphQL API facts (D6)

Live-probed 2026-10-23 with a PAT-classic token against api.github.com
(`scripts/gh-projects-recon.mjs` + `scripts/gh-projects-probe.mjs`, P0–P11
ALL PASS; the probe is self-cleaning + `--cleanup-probes`). Everything below
is VERIFIED API behavior, not docs folklore.

## Mutations that matter (and their exact shapes)

- `createProjectV2(input: {ownerId, title})` — user-owned board.
- `createProjectV2Field(input: {projectId, dataType, name, singleSelectOptions})`
  — `singleSelectOptions: [{name, color, description}]`; **`description` is
  REQUIRED on every option** (probe P2: "Expected value to not be null"), and
  **SINGLE_SELECT creation REQUIRES ≥1 option** ("At least one singleSelectOption
  is required for data_type SINGLE_SELECT") — the bootstrap seeds an inert
  `General`/GRAY the user can rename/delete.
- `updateProjectV2Field(input: {fieldId, singleSelectOptions})` — **FULL-LIST
  REPLACE**: pass EVERY existing option back WITH its `id` (+ name + color +
  description) and append the new ones without ids → ids are preserved and
  **item assignments SURVIVE** (probe P6+P8 re-read proof). This is the ONLY
  way to add options via API. `color` is required on the id-preserved options
  too (probe P6 failure → fix).
- `addProjectV2DraftIssue(input: {projectId, title, body})` → payload field is
  **`projectItem`** (NOT `projectV2Item`); the draftIssue id comes from
  `projectItem { content { ... on DraftIssue { id } } }`.
- `updateProjectV2DraftIssue(input: {draftIssueId, title?, body?})` — title/body
  edits work on draft items.
- `updateProjectV2ItemFieldValue(input: {projectId, itemId, fieldId, value})` —
  `value: {singleSelectOptionId}` or `{text}`.
- `clearProjectV2ItemFieldValue(input: {projectId, itemId, fieldId})` — clears.
- `deleteProjectV2Item(input: {projectId, itemId})` — payload selection:
  `clientMutationId` (the payload has NO projectV2Item field).
- `deleteProjectV2(input: {projectId})`.
- `createProjectV2View(input: {projectId, name, layout})` — layout enum is
  **`TABLE_LAYOUT` / `BOARD_LAYOUT` / `ROADMAP_LAYOUT`** (NOT TABLE_VIEW).
  `UpdateProjectV2ViewInput` = {viewId, name, layout, filter, configuration:
  {visibleFieldIds}} — **grouping is NOT API-settable** (no groupBy anywhere;
  `ProjectV2ViewConfigurationUpdate` does not exist). The view NAME carries
  the "group by Epic" instruction; the UI click is the user's.

## Read shapes

- `ProjectV2FieldConfiguration` (mutation payloads) is a **UNION** — select
  field ids via `... on ProjectV2FieldCommon { id name dataType }`.
- `fields(first: N)` — 50 covers any sane board. `items(first: 100, after:
  $cursor)` **MUST page** (pageInfo.hasNextPage/endCursor) — one page
  truncates and duplicate-mints on the next pass (audit P1-1).
- Item `fieldValues(first: N)` include the built-in Title value — filter by
  `field.name`, not "first text".
- GraphQL variables must be DECLARED even when the values come from JS (the
  fake-transport suite is declaration/selection-BLIND — live E2E finds #1
  [`$login` undeclared] and #2 [project `id` never selected] were invisible
  offline; always live-verify a new query shape).

## Limits / gotchas

- **`color` must be from GitHub's EXACT accepted enum** (live find
  2026-10-27): GRAY, BLUE, GREEN, YELLOW, ORANGE, RED, PINK, PURPLE — nothing
  else. Plausible-looking BROWN/CYAN/MAGENTA/TAN make the ENTIRE
  UpdateProjectV2Field mutation fail ("provided invalid value for
  singleSelectOptions.N.color"), and because option-append is a FULL-LIST
  replace, one invalid color blocks every missing option in the batch — the
  mirror latches `error` until the palette is fixed (the user's first
  @epic:@story: test pin hit exactly this). Guard test: scripts/project-sync-test.mjs
  pins OPTION_COLORS ⊆ the accepted set (read from ghProjects.ts source).
- `fieldValues(first: 30) per item is plenty for our shape (Title + Epic +
  Story + Capture + DOM anchor + Status ≈ 6).
- The REST `issue-token` scope on a classic PAT covers all of the above.
- Rate limits are generous for a reconcile cadence (event-debounced + hourly);
  coalesce trigger storms into one pass (review P3-4).

## ProjectV2Item.updatedAt (live-probed 2026-10-29, s6 D16 recon)

- `items(first: N) { nodes { id updatedAt createdAt content { ... on
  DraftIssue { id updatedAt } } } }` — `ProjectV2Item.updatedAt` EXISTS and
  bumps on FIELD writes (live: item 10:33:35 vs its DraftIssue content
  10:33:33 after a mirror field-write pass) — the ITEM-level clock tracks
  field-value changes, the content-level clock tracks body edits. Use
  ITEM-level for board-edit freshness (D16 tier-2 rule).
- Both are GitHub-server clocks — cross-system comparisons against the local
  store's comment `createdAt` need a slack band (ms-clocks meta-rule).
- Reading them is a NEW selection on the paged item query: add to
  ITEMS_PAGE_QUERY when implementing D16 (must stay inside the 50/100
  page caps already pinned).
