/**
 * dom-annotakit — the serve-mode GH Projects mirror sidecar (D6).
 *
 * Owns ONE job: converge the local store to the spec board via
 * reconcileProject (src/shared/ghProjects.ts) and publish an honest status.
 *
 * Wiring (all NEW-code seams — zero vendored edits):
 *   - started by standalone.ts at boot with the channel emitter;
 *   - re-arms on THREADS_CHANGED (5s debounce) — INCLUDING reason:'restored'
 *     (P1-3: post-restore convergence is immediate);
 *   - hourly sweep (unref'd — never holds the process open);
 *   - single-flight (P2-4): passes serialize through a promise-chain mutex;
 *   - status served at GET /dom-annotakit-project.json (standalone route).
 *
 * Config (config > env > baked for the target; env > config > baked for the
 * token — engine-aligned, fold P3-4): annotakit.config.json "project"
 * {target, token?, publicUrl?, auto?}. The token's env var was pre-applied by
 * standalone.ts (shell > .env > BAKED, fold P1-4) — ghToken() sees the same
 * value the vendored engine does.
 *
 * Delete evidence (P1-3): the sidecar reads the ENGINE'S store singleton —
 * same getStore(configDir, {dataDir: storeLocation(...)}) argument shape
 * routes.ts bootstrap uses (routes.ts:115-117) → same instance, whatever the
 * boot order. listDeletedIds() is the ONLY delete authorization.
 */

import { THREADS_CHANGED } from '../shared/events';
import { BAKED_GH_TOKEN, BAKED_PROJECT_TARGET } from '../shared/bakedCreds';
import { makeGql, parseProjectTarget, reconcileProject, type ProjectSyncTarget, type ReconcileResult } from '../shared/ghProjects';
import type { SpecCatalog } from '../shared/specCatalog';
import { getStore, readConfig } from './store';
import { storeLocation } from './env';

export interface ProjectMirrorStatus {
  state: 'ok' | 'error' | 'dormant';
  /** dormant/error explanation (P2-9). */
  reason: string | null;
  target: string | null;
  projectTitle: string | null;
  projectUrl: string | null;
  threads: number;
  items: number;
  lastSyncAt: string | null;
  lastError: string | null;
  /** which writer converged last (P2-2: dual-instance awareness). */
  writer: string;
  /** the REAL recovery path (P1-4: .env+reload cannot override baked-backed keys). */
  recovery: string;
  /** D14: true when the vendored ISSUES mirror is disarmed (ghAuto:false) —
   *  the panel renders the Projects board drawer instead of the issues UI. */
  issuesDisarmed: boolean;
}

interface ProjectSection {
  target?: unknown;
  token?: unknown;
  publicUrl?: unknown;
  auto?: unknown;
}

const RECOVERY = 'rotate ANNOTAKIT_GH_TOKEN in the shell environment (or annotakit.config.json "project.token") and restart the server — a baked-backed token cannot be rotated through .env + POST /gh/reload';

export interface ProjectMirror {
  status(): ProjectMirrorStatus;
  /** Debounced re-arm (channel event path). */
  trigger(): void;
  /** Force a pass now (single-flight; resolves after the pass settles). */
  reconcile(): Promise<ReconcileResult | null>;
  /** D10: the last pass's board-derived catalog (options + pass edges) —
   *  null before the first pass / when dormant. READ-ONLY. */
  catalog(): SpecCatalog | null;
  /** True when the vendored issues mirror is disarmed for this instance —
   * standalone.ts uses this to intercept POST /annotakit/api/sync + /gh
   * (audit P1-2: syncAll() gates on configured(), not enabled()). */
  issuesMirrorDisarmed(): boolean;
}

export interface StartProjectMirrorOpts {
  configDir: string;
  /** the standalone port — the default publicUrl boot origin. */
  port: number;
  /** THREADS_CHANGED channel emitter (standalone's EventEmitter). */
  channel: { on: (e: string, cb: (...a: unknown[]) => void) => void };
  /** manifest-derived display name resolver (standalone's buildManifest + captureName). */
  resolveCaptureName: (storyId: string) => string | undefined;
  /** The last PUBLIC host seen on a request (Host header through the proxy
   *  chain) — beats the localhost fallback for board deep-links. Same
   *  discipline as the vendored origin tracking (routes.ts:1440): public
   *  hosts only, never loopback noise. */
  publicHost: () => string | null;
  log?: (...args: unknown[]) => void;
}

export function startProjectMirror(opts: StartProjectMirrorOpts): ProjectMirror {
  const log = opts.log ?? ((...a: unknown[]) => console.log('[dom-annotakit]', ...a));
  const rawConfig = readConfig(opts.configDir);
  const project = (rawConfig.project ?? null) as ProjectSection | null;
  const issuesDisarmed = rawConfig.ghAuto === false;

  /* target: config > env > baked */
  const targetRaw = typeof project?.target === 'string' && project.target.trim()
    ? project.target.trim()
    : process.env.ANNOTAKIT_PROJECT_URL || BAKED_PROJECT_TARGET;
  const target = targetRaw ? parseProjectTarget(targetRaw) : null;

  /* token: env (shell > .env > baked, pre-applied by standalone) > config > baked */
  const token =
    process.env.ANNOTAKIT_GH_TOKEN ||
    (typeof project?.token === 'string' && project.token.trim() ? project.token.trim() : '') ||
    BAKED_GH_TOKEN;

  const auto = project?.auto !== false;

  /** publicUrl is LAZY per pass (live E2E find #7): the public host only
   *  becomes known after the first proxied request lands — capturing it at
   *  boot minted localhost:4310 deep links forever. Explicit config wins
   * outright; otherwise the last-seen public host; otherwise the boot origin. */
  const resolvePublicUrl = (): string => {
    if (typeof project?.publicUrl === 'string' && project.publicUrl.trim()) {
      return project.publicUrl.trim().replace(/\/+$/, '');
    }
    const host = opts.publicHost();
    return host ? `https://${host}` : `http://localhost:${opts.port}`;
  };

  let status: ProjectMirrorStatus = {
    state: 'dormant',
    reason: null,
    target: targetRaw || null,
    projectTitle: null,
    projectUrl: null,
    threads: 0,
    items: 0,
    lastSyncAt: null,
    lastError: null,
    writer: 'serve',
    recovery: RECOVERY,
    issuesDisarmed: issuesDisarmed,
  };
  /* D10: the last pass's board catalog (frozen at pass success) */
  let lastCatalog: SpecCatalog | null = null;

  const config: { target: ProjectSyncTarget; token: string } | null = target && token ? { target, token } : null;

  if (!auto) {
    status = { ...status, state: 'dormant', reason: 'project.auto is false — the board mirror is switched off in annotakit.config.json' };
    log('project-sync: dormant (project.auto false)');
  } else if (!target) {
    status = { ...status, state: 'dormant', reason: `no valid project target — set "project.target" in annotakit.config.json (got ${JSON.stringify(targetRaw ?? null)})` };
    log('project-sync: dormant (no valid target)');
  } else if (!token) {
    status = { ...status, state: 'dormant', reason: 'no GH token (env ANNOTAKIT_GH_TOKEN / config project.token / baked default)' };
    log('project-sync: dormant (no token)');
  }

  /* the store singleton — the EXACT argument shape routes.ts bootstrap uses,
   * so whichever side calls getStore first, both share one instance (P1-3).
   * Boot-time failure must be LOUD but not FATAL (review P3-5): a locked
   * threads.db must never take static/capture serving down with it — the
   * mirror goes dormant with the reason surfaced in status. */
  let store: ReturnType<typeof getStore> | null = null;
  let storeError: string | null = null;
  const getStoreSafe = (): ReturnType<typeof getStore> | null => {
    if (store) return store;
    if (storeError) return null;
    try {
      const gitFlowOn = rawConfig.autoSync !== false;
      const loc = storeLocation(opts.configDir, { forceClassic: !gitFlowOn });
      store = getStore(opts.configDir, { dataDir: loc.dir });
      return store;
    } catch (err) {
      storeError = err instanceof Error ? err.message : String(err);
      status = { ...status, state: 'error', reason: `store unavailable: ${storeError}`, lastError: storeError };
      log('project-sync: store unavailable — mirror dormant:', storeError);
      return null;
    }
  };

  /* single-flight (P2-4): passes serialize; trigger() coalesces storms into
   * ONE queued pass (review P3-4 — a bulk import must not queue N full-board
   * reads; the static twin's cancel-and-rearm pattern). */
  let chain: Promise<void> = Promise.resolve();
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  const runPass = (why: string): Promise<ReconcileResult | null> => {
    const st = getStoreSafe();
    if (!config || !st) {
      return Promise.resolve(null);
    }
    const store = st;
    const pass = chain.then(async () => {
      try {
        const result = await reconcileProject({
          gql: makeGql(config.token),
          config: { ...config, publicUrl: resolvePublicUrl() },
          listThreads: () => store.listThreads(),
          listDeletedIds: () => store.listDeletedIds(),
          captureName: opts.resolveCaptureName,
          log,
        });
        status = {
          ...status,
          state: 'ok',
          reason: null,
          projectTitle: result.projectTitle,
          projectUrl: result.projectUrl,
          threads: result.threads,
          items: result.items,
          lastSyncAt: new Date().toISOString(),
          lastError: null,
          writer: 'serve',
          recovery: RECOVERY,
        };
        lastCatalog = result.catalog;
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        status = { ...status, state: 'error', lastError: msg, reason: msg, lastSyncAt: status.lastSyncAt };
        log(`project-sync: FAILED (${why}):`, msg);
        return null;
      }
    });
    /* keep the chain alive even when a pass throws (already caught above) */
    chain = pass.then(() => undefined, () => undefined);
    return pass;
  };

  const trigger = (why: string, delayMs: number): void => {
    if (!config || !auto) return;
    /* coalesce: a storm of THREADS_CHANGED events re-arms ONE timer */
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      void runPass(why);
    }, delayMs);
    pendingTimer.unref?.();
  };

  if (config && auto) {
    /* boot pass — safe at ANY store state (P1-3: deletes are evidence-gated,
     * so racing the engine's async restore converges instead of wiping) */
    trigger('boot', 6_000);
    /* engine mutations — debounced; 'restored' re-arms too (post-restore
     * convergence is immediate rather than waiting for the hourly sweep) */
    opts.channel.on(THREADS_CHANGED, (...args: unknown[]) => {
      const payload = args[0] as { reason?: string } | undefined;
      if (payload?.reason === 'restored') trigger('restored', 1_000);
      else trigger('threads-changed', 5_000);
    });
    /* hourly sweep — catches drift the events missed */
    const sweep = setInterval(() => {
      void runPass('hourly-sweep');
    }, 60 * 60 * 1000);
    sweep.unref?.();
  }

  return {
    status: () => ({ ...status }),
    trigger: () => trigger('manual', 0),
    reconcile: () => (config && auto ? runPass('forced') : Promise.resolve(null)),
    catalog: () => lastCatalog,
    issuesMirrorDisarmed: () => issuesDisarmed,
  };
}
