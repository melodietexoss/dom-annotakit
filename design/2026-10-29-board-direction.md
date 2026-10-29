# D16 — board→store direction (the Projects mirror's second direction) — REV 3 (C′, FINAL)

Written 2026-10-29, session 6. REV 1 → audit 6-a (APPROVE-WITH-FOLDS, 10
folds) → REV 2 → certify 6-b (FIX-FIRST: 2 blockers B1/B2 + notes N1–N9,
re-cert waived for matching folds). This REV 3 folds B1+B2+N1–N9; the
DECISION IS FINAL — implement §3–§8 in order.

## 1. Problem statement

The GH Projects mirror is **one-way**: local threads → board items. If a
reviewer edits a board item's Epic or Story field on the GitHub side, the
next automatic pass (boot+6s, every THREADS_CHANGED after a 5s debounce,
hourly — `projectMirror.ts:238-254`) **silently reverts it**
(`ghProjects.ts:419-428` diff-overwrite). So the board is worse than
"does not flow back": it accepts the edit, then destroys it with no trace.
(Re-file caveat today lives ONLY in the drawer tooltip —
`ReviewPanel.tsx:1105`; AGENTS.md has no such wording — REV-1 §1 factual
fix.)

The gap is real for ONE flow: **re-filing an existing thread**. In the app,
epic/story ride on comment-body directives (`@epic: X` re-files —
`specDirectives.ts`); the natural UI paths set directives at PIN time, but
re-filing an OLD thread means hand-typing a directive reply. On the board,
re-filing is a single-select click — and per the above, today it is a trap.

## 2. Facts the design rests on (all code-verified; audit-confirmed)

- Item↔thread identity: byte-0 marker holds the thread id (id-shape gate);
  the reconciler paged-reads all items + field values every pass.
  ⚠ marker-FUL foreign items: `THREAD_ID_RE` (`ghProjects.ts:71`) accepts
  any well-formed `th_…` id — ANOTHER deployment's items parse as claimed
  under one board. Convergence is safe (iterates desired only,
  `ghProjects.ts:561`), but INGEST must require the thread to exist in the
  LOCAL store.
- Board edits are reverted by every automatic pass (`ghProjects.ts:419-438`).
- Threads: epic/story = directive values folded from comment bodies, LAST
  directive wins; re-file = append a directive-carrying comment. The append
  rides the PATCH door (`store.updateThread` via the reply composition,
  `routes.ts:1147-1172` — REV-1 wrongly said "create door"), with stable
  comment ids giving replay idempotency (`routes.ts:1163-1170`).
- `ProjectV2Item.updatedAt` EXISTS and bumps on field writes (live-probed
  2026-10-29; kb/gh-projects-api.md updated). It is a GitHub-server clock —
  cross-system comparisons need a slack band.
- Deletions: local tombstones delete their items (evidence-gated,
  `store.ts:299-315`, `projectMirror.ts:196`); board-side removals are
  transient (the pass re-creates while the thread lives).
- Mirror fields: exactly FOUR — Epic, Story, Capture, DOM anchor
  (`ghProjects.ts:131-134, 518-521`). Thread status rides a BODY line only
  (`ghProjects.ts:306`) — there is NO status field to ingest. REV-1's
  "or its status" scope and the "thread-456 resolved" sample are STRUCK.
- Directives can only SET values (`specDirectives.ts:32-36` drops empty);
  board-side CLEARS are un-adoptable by construction.
- All-native module (no drift-check exposure; COPY-MAP may need a
  descriptive row at most).
- Normalization: `cleanValue` clips to 60 chars + collapses whitespace
  (`specDirectives.ts:32-36`) — board option names beyond that
  round-trip to a DIFFERENT value.
- Ingest comments ride the ISSUES reply-mirror when it is ARMED
  (`issuesDisarmed = rawConfig.ghAuto === false`, `projectMirror.ts:98`) —
  board re-files would spam GH issues as machine-authored replies.
- The static twin (`projectClient.ts`) runs the same `reconcileProject` on
  boot/store-change/storage-event/hourly (`projectClient.ts:188-208`) with
  NO Sync-now UI and no report surface.

## 3. The decision — Option C′ (REV 2)

**Opt-in two-way, adoption on the explicit Sync-now click, with
preserve-and-flag on automatic passes.**

1. Config: `project.twoWay` (default `false`) AND requires
   `issuesDisarmed` (the armed issues mirror would re-publish ingest
   comments as issue replies — machine noise on the user's issue stream;
   board-owned deployments are the D14 shape). twoWay requested while
   ghAuto is on → the ingest stays disarmed with the reason surfaced in
   status.
2. The ingest capability is an explicit `reconcileProject` DEP passed only
   by the serve-mode mirror — never a `ProjectSyncConfig` field the static
   bake could set via a hand-edited `annotakit-gh.json`. Static twin: v1
   stays one-way, documented.
3. Pass shape (mode param: `'auto' | 'manual'`):
   a. `loadBoard` (unchanged paged read + the NEW `updatedAt` selection).
   b. **Ingest phase — manual passes ONLY**, per item where board Epic/Story
      ≠ the thread's current directives, through the eligibility gates
      (§4) and the tiered conflict rule (§5). Appends a directive comment
      through the patch door with a stable id + author `"board-sync"`.
      **Body shape is PINNED (B2 fold) — the directive MUST sit at line
      start with the annotation NEVER on the directive line**
      (`DIRECTIVE_LINE_RE` is line-start anchored, `specDirectives.ts:24`;
      `cleanValue` keeps same-line annotations as part of the value):

      ```
      Re-filed from the board (was Old Epic).
      @epic: New Epic
      ```

      Prose line first, directive line last. A body like "Re-filed from
      the board: @epic: X (was Y)" would extract NO directive, change
      nothing, and the same pass's convergence would revert the edit
      while the report claimed an adoption.
   c. **Store re-read** (listThreads AGAIN after appends — sequencing
      invariant: ingest MUST complete before the desired-state build, or
      the same pass reverts the adoption and every Sync-now re-adopts
      forever).
   d. Desired build + convergence, with **preserve-and-flag** on auto passes
      — the rule pinned (N1 fold): an AUTO pass preserves a board edit
      UNLESS `directiveAge > boardWrite + slack` (clearly newer local
      re-file → converge + count the revert in status, N6); ambiguous and
      clearly-board-newer pairs are PRESERVED with `pendingBoardEdits`
      incremented (a per-pass RECOMPUTE of currently-preserved diffs, N4 —
      never an accumulator). Sync now resolves pending edits.
4. Never ingest deletions (board removal is transient by design; killing
   threads from a board click would weaponize the mirror).
5. Never ingest clears (un-adoptable) — the Sync-now report surfaces them:
   "cleared on board — not adoptable, re-filed to X".
6. Capture/DOM anchor (and title/body) board edits: never ingested (no
   directive grammar can express them), never silently ignored — the
   report counts them ("2 board edits not adoptable (derived fields) —
   reverted"), and the caveat copy warns that editing item BODIES can
   orphan the item (byte-0 marker) and duplicate-mint a fresh one
   (`ghProjects.ts:86-92, 564-566`).
7. Loud report: the Sync-now result carries `lastAdopted[]` + counts;
   automatic passes carry `pendingBoardEdits` in status. The drawer's
   caveat switches to the honest twoWay wording: "Board Epic/Story edits
   are adopted when you click Sync now — until then, automatic passes
   preserve pending board edits and flag them here."

## 4. Ingest eligibility gates (all must pass per item)

1. Marker parses at byte 0 with the id-shape gate (marker-less items: not
   ours — invisible to ingest).
2. Thread exists in the LOCAL store AND not in `listDeletedIds()`
   (tombstoned — the same pass deletes the item; appending is churn).
   Closes the marker-ful foreign-item hole (§2 bullet 1).
3. Board field value ≠ thread directive value (pre-normalize BOTH sides
   of the diff with `cleanValue` so the comparison matches what a
   round-trip can hold).
4. Field is Epic or Story only.
5. **Round-trippable value only (B1 fold):** `cleanValue(boardValue) !==
   boardValue` → **notAdoptable, reported** (the same bucket as clears — a
   70-char board name would otherwise be adopted, parse to the 60-char
   clip, and the SAME pass's convergence would mint the clip as a NEW
   option via ensureOptions, silently renaming the user's board selection
   — the raw-vs-raw convergence diff at `ghProjects.ts:419-428` runs
   AFTER the ingest's pre-normalized one). §6's convergence no-op claim
   is scoped to round-trippable values exactly because of this gate.

## 5. Tiered conflict rule (REV 2 — replaces append-wins-by-construction)

- **Tier 1 (mandatory, clock-free): pre-append directive re-read.**
  Immediately before appending, re-read the thread's current directives;
  if the value changed since the pass's initial read (a local re-file
  landed mid-pass — the loadBoard→append window is tens of seconds on a
  real board), SKIP + report "thread re-filed locally during sync — board
  edit skipped". Closes the mid-pass race without clocks. (REV-1's "next
  Sync-now re-adopts" was analytically FALSE — the ingest removes the very
  diff a later pass would re-detect. Struck.)
- **Tier 2 (freshness): directive-age vs item.updatedAt.**
  directiveAge (**per field**, N3): the createdAt of the last comment
  bearing a directive for THAT field (last `@epic`-bearing comment for
  the epic comparison — last-any-directive gives wrong verdicts when
  epic and story were re-filed at different times); a thread with NO
  directive-bearing comment for the field falls back to `thread.createdAt`
  (N2 — never-filed threads). boardWrite = `ProjectV2Item.updatedAt`
  (live-verified; kb). Slack band (default ±5 min, config
  `project.clockSlackMs`):
  boardWrite > directiveAge + slack → ADOPTABLE (the board edit is newer);
  directiveAge > boardWrite + slack → NOT adoptable — converge over the
  board and REPORT the revert ("board edit superseded by a newer local
  re-file" — auto passes COUNT it, N6);
  |boardWrite − directiveAge| ≤ slack → AMBIGUOUS (cross-system clocks) —
  defer to the human: skip + flag in the report ("board edit is ambiguous
  against a recent local re-file — re-file in one place").
  On AUTO passes the same comparison runs WRITE-side (preserve-and-flag).
  ⚠ **Machine-pollution caveat (N5):** the item clock bumps on OUR OWN
  field writes (kb) and it is UNPROBED whether DraftIssue *body* edits
  bump the item-level clock — a sibling field write can slide boardWrite
  past directiveAge and make a stale board edit look adoptable. Before
  implementing tier 2: (i) live-probe the body-edit→item-clock question;
  (ii) keep an in-memory last-write-time map per item (serve-mode
  singleton suffices) and require boardWrite to postdate it for
  adoptability. Tier 3 keeps any residual misadoption visible + one reply
  from repair.
- **Tier 3 (always): the append is visible + reversible.** The comment
  body carries the overridden local value ("(was Y)") — a wrong adoption
  is explicit in the audit trail and one reply away from repair.

## 6. Echo-safety (R3, REV 2 — qualified + test-pinned)

The reconciler compares VALUES, never clocks (`BoardItem` has no updatedAt
today; title/body/Epic/Story/anchor diffs are string compares). Adopt →
directives == board → same-pass convergence no-ops the field writes; the
body rewrites once (the appended comment becomes a numbered
`## Directives` line, `ghProjects.ts:318-329`) and converges. A NO-OP second
pass follows (value-based, not clock-based). Qualifications:

1. The sequencing invariant (§3.3.c) is LOAD-BEARING — pinned by test.
2. Normalization round-trips (60-char clip, whitespace collapse) are
   handled by the round-trippable gate (§4.5), not by the write path
   (`cleanValue` does NO case folding — the earlier "case" matrix entry
   is a phantom, N9, trimmed).
3. Known pre-existing non-settling shape (independent of twoWay, recorded
   for the backlog): `want.anchor = ''` vs unset-board `null` can rewrite
   every pass (`ghProjects.ts:438`) — the R3 test matrix generalizes over
   normalization shapes (empty-string, 60-clip, whitespace), not
   just the happy path.

## 7. Test plan (project-sync suite additions)

(a) ingest appends the directive comment + re-files + report carries it;
(b) double Sync-now idempotency (second pass = no-op, R3 pin);
(c) mid-pass local-edit guard (tier 1) skips + reports;
(d) tier-2 matrix: board-newer adopts, local-newer converges+reports,
    slack-band flags;
(e) clears never ingested + surfaced;
(f) Capture/anchor/title/body edits never ingested + counted;
(g) marker-ful foreign items (valid th_ id, absent locally) skipped
    silently (NOT "rejected" — not ours);
(h) tombstoned threads skipped;
(i) marker-less items skipped;
(j) ingest before desired-build (sequencing pin: adopt then converge,
    not converge then adopt);
(k) twoWay absent/false → identical behavior to today (default-unchanged);
(l) twoWay true + ghAuto true (issues armed) → ingest disarmed with reason;
(m) auto passes preserve-and-flag (pendingBoardEdits per-pass recompute)
    + never append + auto-reverts counted (N4/N6);
(n) normalization matrix: 60-clip / whitespace / empty-string
    pre-normalized diff → reported, never round-trip-renamed (the
    round-trippable gate, §4.5); case is OUT (no case folding exists);
(o) ingest comment body shape: directive extracted + the annotation
    never part of the value (the B2 pin).

## 8. Status + UI plumbing

- Dep signature (N9): `reconcileProject` takes a `mode: 'auto' | 'manual'`
  param (the serve mirror maps `reconcile()` → `'manual'`, `trigger()` →
  `'auto'`) + an optional `ingest` capability dep (serve-mode only).
- `ProjectMirrorStatus`/`ProjectStatusShape` += `twoWay: boolean`,
  `pendingBoardEdits: number` (per-pass recompute, N4), `autoReverts:
  number` (N6), and the LAST MANUAL PASS'S FULL REPORT — the four arrays
  `adopted[]` (entries `{threadId, field}`), `skipped[]`, `flagged[]`,
  `notAdoptable[]` (N8) — folded into status because the Sync-now door
  responds with `status()` (`hostRoutes.ts:666`); replaced per manual
  pass, bounded by the per-pass diff count.
- Drawer caveat copy switches on `twoWay` (§3.7 wording); a
  twoWay-requested-but-disarmed mirror (issues armed) surfaces its reason
  in the OK state too (N7 — today `reason` renders only in the
  dormant/error branches, `ReviewPanel.tsx:1117-1119`).
- The Sync-now result IS the status report (the POST responds with
  `status()`, so the four arrays ride it — no second response shape).
- THREADS_CHANGED after ingest appends: the mirror's channel is `{on}`-only
  today; v1 accepts the panel's ~5s poll convergence (routes emit via
  afterMutation; the mirror does not) — documented, no channel widening in
  v1 (small surface, revisit with real usage).
- Author/createdAt conventions: author `"board-sync"`, server-stamped
  createdAt, stable comment id shape reused from the reply door
  (`routes.ts:1157-1170`) for replay idempotency.

## 9. Audit trail

- REV 1 → fresh-context adversarial audit (6-a): APPROVE-WITH-FOLDS
  (10 folds: conflict-rule rewrite P1, auto-pass clobber race P1, clears
  rule P2, status strike P2, sequencing pin P2, eligibility gates P2,
  static/issues positions P2, factual nits P3, UI plumbing P3,
  rejected-edit surfacing P3). All folded in REV 2.
- Live recon: `ProjectV2Item.updatedAt` probe (kb updated).
- REV 2 → certify round (6-b): FIX-FIRST — B1 (the ingest's
  pre-normalized diff does not reach the convergence path: a
  non-round-trippable board name gets adopted, parses to the 60-char clip,
  and the same pass mints the clip as a NEW option — silently renaming
  the user's board selection) + B2 (the pinned comment body put `@epic:`
  mid-line where the line-start-anchored directive regex extracts
  NOTHING — the Sync-now click would revert the edit it reports adopted)
  + N1–N9 (auto-pass trigger pinned, per-field directive age + fallback,
  per-pass pendingBoardEdits recompute, the machine-polluted item-clock
  caveat + required probes, auto-revert surface, disarm-reason surface,
  report-shape naming, phantom case entry + dep signatures). All folded
  here (REV 3); re-cert waived for matching folds per 6-b.
- **DECISION FINAL (2026-10-29): implement C′ (§3–§8) — next session's
  scope #1.** Pre-implementation probes required by the doc: the
  body-edit→item-clock question (§5 N5) + the in-memory last-write map.
  Live E2E plan: controlled board edit → Sync now → adopted + reported +
  no ping-pong (second pass no-op) → re-file back + converge.
