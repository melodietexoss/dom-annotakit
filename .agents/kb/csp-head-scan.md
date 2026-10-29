# kb: CSP head-scan boundary — what real SingleFile captures actually look like

The CSP-meta strip (serveCapture in `src/server/standalone.ts` + the bake
TWIN `scripts/bake-dom-annotakit.mjs`) removes SingleFile's freeze-CSP meta
in-memory so the injected layer module can load. Measured facts from the
real GenEditor corpus (31 captures, session 2026-10-23 — the live E2E that
found the original 512KB single-slice assumption layer-dead on 19/31):

## The three head shapes (measure, don't assume)

1. **Small head** (12/31): `</head>` well inside 512KB — the old code's only
   working shape. The magnific-folder-* family happens to be here (why the
   session-1 smoke looked green).
2. **Inflated head** (16/31 boundary past 512KB; largest boundary 1.62MB):
   SingleFile inlines base64 data: URIs (images, fonts, favicons) into
   `<head>` styles/links — `</head>` can sit ~1.6MB in on a 66MB capture.
   Never assume a head fits any fixed slice: scan adaptively
   (HEAD_SCAN_STEPS 512KB → 2MB → 4MB, re-read from 0, `want <= read` guard,
   stop at boundary or EOF, honest-RAW + loud warn at the cap).
3. **No literal `</head>` at all** (5/31 — the luma + openart/oepnart
   families): the serializer writes `<head>…` then opens `<body` directly
   (HTML parsers auto-close the head at <body). The boundary regex must
   accept `</head\s*>` OR `<body[\s>]` — earliest match wins. The stream
   resumes AT the boundary byte (headPart = everything before it), so
   `<body…` passes through byte-identical.

## Byte math (the splice)

`headStr` = utf8-decoded scanned region; `headPart = headStr.slice(0,
headCloseIdx)` (CHAR index); `restStart = Buffer.byteLength(headPart)` (the
BYTE offset where the tail stream resumes). The strip regex matches
ASCII-only meta markup, so multibyte head content passes byte-identical.
Validated byte-exact on 11 synthetic shapes + all 31 real captures
(including emoji straddling the scan cut points). Known pre-existing
residual (inherited from upstream math, not a regression): non-UTF-8
(latin1) files can drift ~2 bytes at the splice — none in the corpus;
hardening = byte-level (latin1-view) boundary scan, backlog.

## Residuals, honestly

- **False boundary**: `<body[\s>]` can match inside a head ATTRIBUTE value
  (serializers do not escape `<` in attr values). Failure mode = partial
  strip (bytes stay exact, CSP meta survives, layer blocked SILENTLY).
  Mitigation in place: when the boundary is `<body`-shaped AND a CSP meta
  survives beyond it in the scanned region → console.warn (both twins).
  Corpus 2026-10-23: 0 occurrences.
- **Boundary-less giants**: no boundary within the 4MB cap → serve RAW +
  loud warn (the host's injection-failure notice takes over). This is the
  designed honest degrade — never stretch the cap to "just make it work".
- **`<body` with no following whitespace/`>`** (`<bodyclass`) does not
  match — correct: the HTML tokenizer wouldn't treat it as body either.

## The TWIN contract

`serveCapture` (server) and `copyCaptureStripped` (bake) must stay
behaviorally byte-identical: same steps, same regex, same warn conditions,
same raw fallback. When editing one, edit both, and run
`node scripts/bake-dom-annotakit.mjs --selftest` (56 probes) + the server
probe (`curl :4310/captures/<file>` + grep the served bytes) before sealing.
