# Upstream issue draft — sync.ts offline-fallback parents on the WRONG ref classification

**Repo:** melodietexoss/storybook-annotakit-dev · **File:** src/server/sync.ts
**Found:** dom-annotakit session 6 (2026-10-29), while running the vendored
engine in its documented private-repo no-token shape (ANNOTAKIT_GH_REPO set,
no ANNOTAKIT_GH_TOKEN). Fixed downstream via a COPY-MAP'd edit; same fix
applies upstream verbatim. **FILED UPSTREAM as issue #21**
(https://github.com/melodietexoss/storybook-annotakit-dev/issues/21).

## The bug

`fetchRemote` returns only the remote head SHA:

```ts
const fetchRemote = async (timeoutMs, targetBranch?): Promise<string | null> => {
  // ... git fetch <url> +refs/heads/<b>:refs/annotakit/remote
  if (head.ok && SHA_RE.test(head.out.trim())) return head.out.trim();
  if (!f.ok) {
    const cached = await readCachedRemoteHead();   // cache ref OR origin tracking ref
    if (cached) return cached.sha;                 // ← the ref is KNOWN but dropped here
  }
  return null;
};
```

When the fetch fails (private repo + no token, offline), the head comes from
`readCachedRemoteHead()` — usually `refs/remotes/origin/<branch>` on a fresh
clone. But every A14 classification gate then reads the kind off the
HARD-CODED cache ref:

```ts
const remoteHead = await fetchRemote(timeoutMs);
let parent = remoteHead;
if (parent) {
  const kind = await refReadmeKind(REMOTE_CACHE_REF);   // ← not the ref that supplied the head
  if (kind === 'no-readme' || kind === 'foreign') { parent = null; }   // cache ref absent → 'no-readme'
}
```

In that shape `refs/annotakit/remote` does not exist → `refReadmeKind`
returns `'no-readme'` → **the parent is nulled → every snapshot is a
parentless root → non-fast-forward pushes forever** (each push rejected,
A4.5 re-merge recovers one snapshot at a time; the branch accumulates roots —
we measured 3 parentless roots in one live branch before writing a manual
priming workaround).

The same hard-coded-ref read appears at the restore adoption site (where it
is partially mitigated because `readCachedRemoteHead()` already returns
`{sha, ref}` and the restore gate reads `remote.ref`) and at the A4.5
non-FF re-fetch site (`refHasOurReadme(REMOTE_CACHE_REF)`).

## The fix

Return `{ sha, ref }` from `fetchRemote` and classify against the ref that
actually supplied the head:

```ts
const fetchRemote = async (timeoutMs, targetBranch?): Promise<{ sha: string; ref: string } | null> => {
  // ...
  if (head.ok && SHA_RE.test(head.out.trim())) return { sha: head.out.trim(), ref: REMOTE_CACHE_REF };
  if (!f.ok) { const cached = await readCachedRemoteHead(); if (cached) return cached; }
  return null;
};

// syncOnce parent gate:
const remoteHead = await fetchRemote(timeoutMs);
let parent = remoteHead ? remoteHead.sha : null;
if (parent && remoteHead) {
  const kind = await refReadmeKind(remoteHead.ref);
  // ...
}
```

Also update the three other call sites (restore `fetched`, the C17
fallback-branch probe, the A4.5 `freshHead` re-fetch) to use the returned
`ref`/`sha` fields. We verified: 15/15 real-git store-robust scenarios green
after the change; the offline shape now parents on the tracking ref and
pushes fast-forward without any priming ritual.
