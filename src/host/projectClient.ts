/**
 * dom-annotakit — the static-mode GH Projects mirror client (D6, browser twin
 * of src/server/projectMirror.ts).
 *
 * Arms ONLY when this deployment is the static shape: `await probeMode() ===
 * 'static'` (fold P3-8 — never 'down', which means "server unreachable from
 * an unknown shape" and must not mint board writes). Serve deployments and
 * dev servers never run a second writer.
 *
 * Config source: the baked annotakit-gh.json EXTENDED with a `project`
 * section {target?, token?, publicUrl?, auto?} (the bake writes it; unknown
 * fields are compatible with the vendored probeBakedGhConfig — it casts the
 * JSON). NEVER imports src/shared/bakedCreds (P2-5: dist-app carries zero
 * `ghp_` matches; the bake script is the server-side bridge).
 *
 * Local truth: the staticStore (localStorage). Threads via list(); delete
 * EVIDENCE via the persisted doc's deletedIds (P1-3) — read from the SAME
 * key staticStore persists under ('annotakit:static:' + staticScope(), a
 * vendored-stable prefix; staticScope is the exported half).
 *
 * Single-flight (P2-4) + debounce 5s on store mutations + hourly sweep.
 * Status: dispatched as `dom-annotakit:project-status` CustomEvents — the
 * toolbar chip (projectStatus.ts) renders the same shape the serve endpoint
 * serves.
 */

import { getStaticStore, staticScope } from '../shared/staticStore';
import { probeMode } from '../shared/mode';
import { makeGql, parseProjectTarget, reconcileProject, type ProjectSyncConfig, type ReconcileResult } from '../shared/ghProjects';
import { PROJECT_STATUS_EVENT } from './projectStatus';

interface BakedProjectSection {
  target?: unknown;
  token?: unknown;
  publicUrl?: unknown;
  auto?: unknown;
}

interface BakedGhFile {
  token?: string;
  repo?: string;
  project?: BakedProjectSection;
}

interface StaticMirrorStatus {
  state: 'ok' | 'error' | 'dormant';
  reason: string | null;
  target: string | null;
  projectUrl: string | null;
  threads: number;
  items: number;
  lastSyncAt: string | null;
  lastError: string | null;
  writer: string;
  recovery: string;
}

const RECOVERY = 're-bake with a fresh --gh-token (baked annotakit-gh.json), or configure the board target in annotakit-gh.json "project"';

const PERSIST_KEY_PREFIX = 'annotakit:static:'; // staticStore.ts KEY_PREFIX (vendored-stable)

async function probeBakedGhFile(): Promise<BakedGhFile | null> {
  try {
    const res = await fetch(new URL('annotakit-gh.json', document.baseURI).href, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as BakedGhFile;
  } catch {
    return null;
  }
}

/** persisted deletedIds — the delete-wins evidence (P1-3), from the same
 * localStorage doc the static store persists. */
function persistedDeletedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(PERSIST_KEY_PREFIX + staticScope());
    if (!raw) return new Set();
    const doc = JSON.parse(raw) as { deletedIds?: string[] };
    return new Set(Array.isArray(doc?.deletedIds) ? doc.deletedIds : []);
  } catch {
    return new Set();
  }
}

export async function armProjectClient(): Promise<void> {
  const mode = await probeMode();
  if (mode !== 'static') return; /* dev/serve shapes own the board writer */

  const baked = await probeBakedGhFile();
  const project = baked?.project ?? null;
  const targetRaw = typeof project?.target === 'string' && project.target.trim() ? project.target.trim() : '';
  const target = targetRaw ? parseProjectTarget(targetRaw) : null;
  /* review P1: the bake writes the token INTO the project section; older
   * bakes (and hand-edited files) carried only the top-level token — accept
   * both shapes. */
  const token =
    (typeof project?.token === 'string' && project.token.trim() ? project.token.trim() : '') ||
    (typeof baked?.token === 'string' && baked.token.trim() ? baked.token.trim() : '') ||
    '';
  const auto = project?.auto !== false;

  let status: StaticMirrorStatus = {
    state: 'dormant',
    reason: null,
    target: targetRaw || null,
    projectUrl: null,
    threads: 0,
    items: 0,
    lastSyncAt: null,
    lastError: null,
    writer: 'static',
    recovery: RECOVERY,
  };
  const emit = (): void => {
    window.dispatchEvent(new CustomEvent(PROJECT_STATUS_EVENT, { detail: { ...status } }));
  };

  const config: ProjectSyncConfig | null = target && token ? { target, token, publicUrl: staticScope() } : null;

  if (!auto) {
    status = { ...status, reason: 'project.auto is false in annotakit-gh.json — board sync off' };
  } else if (!target) {
    status = { ...status, reason: 'no "project.target" in annotakit-gh.json — re-bake with the board target' };
  } else if (!token) {
    status = { ...status, reason: 'no token in annotakit-gh.json — re-bake with --gh-token' };
  }
  emit();

  if (!config || !auto) return;

  const store = await getStaticStore();

  /* captureName: the baked manifest next to the app (same M5 shape). */
  let captureNames: Map<string, string> | null = null;
  const nameFor = (storyId: string): string | undefined => {
    if (!captureNames) return undefined;
    return captureNames.get(storyId);
  };
  void (async () => {
    try {
      const res = await fetch(new URL('dom-annotakit-manifest.json', document.baseURI).href, { cache: 'no-store' });
      if (res.ok) {
        const m = (await res.json()) as { captures?: { id: string; relpath: string }[] };
        captureNames = new Map((m.captures ?? []).map((c) => [c.id, c.relpath.replace(/\.[^./\\]+$/, '')]));
      }
    } catch {
      /* names fall back to story.name in the desired-item builder */
    }
  })();

  /* single-flight (P2-4) */
  let chain: Promise<void> = Promise.resolve();
  const runPass = (why: string): Promise<ReconcileResult | null> => {
    const pass = chain.then(async () => {
      try {
        const result = await reconcileProject({
          gql: makeGql(config.token),
          config,
          listThreads: () => store.list(),
          listDeletedIds: () => persistedDeletedIds(),
          captureName: nameFor,
          log: (...a: unknown[]) => console.log('[dom-annotakit project-sync]', ...a),
        });
        status = {
          ...status,
          state: 'ok',
          reason: null,
          projectUrl: result.projectUrl,
          threads: result.threads,
          items: result.items,
          lastSyncAt: new Date().toISOString(),
          lastError: null,
        };
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        status = { ...status, state: 'error', reason: msg, lastError: msg };
        return null;
      } finally {
        emit();
      }
    });
    chain = pass.then(() => undefined, () => undefined);
    if (why === 'boot') void pass;
    return pass;
  };

  void runPass('boot');
  let timer: ReturnType<typeof setTimeout> | null = null;
  store.subscribe(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void runPass('store-changed');
    }, 5_000);
  });
  window.addEventListener('storage', (e) => {
    /* cross-document mutations reach us as storage events (the vendored
     * channel for the static shape) */
    if (e.key && e.key.startsWith(PERSIST_KEY_PREFIX)) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void runPass('storage-event');
      }, 5_000);
    }
  });
  const sweep = setInterval(() => {
    void runPass('hourly-sweep');
  }, 60 * 60 * 1000);
  /* pages unload freely — the interval must not pin the tab */
  window.addEventListener('pagehide', () => clearInterval(sweep), { once: true });
}
