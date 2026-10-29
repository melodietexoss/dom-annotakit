/**
 * dom-annotakit — host-side project-mirror status (D6, fold P2-9).
 *
 * Serve mode: poll GET /dom-annotakit-project.json (served by standalone's
 * static router; proxied through the Next host rewrite). Static mode: the
 * projectClient (src/host/projectClient.ts) dispatches the SAME shape on the
 * window event `dom-annotakit:project-status` (the endpoint 404s there).
 * Whichever source answered last wins — one hook for both shapes.
 */

import { useEffect, useState } from 'react';

export interface ProjectStatusShape {
  state: 'ok' | 'error' | 'dormant';
  reason?: string | null;
  target?: string | null;
  projectTitle?: string | null;
  projectUrl?: string | null;
  threads?: number;
  items?: number;
  lastSyncAt?: string | null;
  lastError?: string | null;
  writer?: string;
  recovery?: string;
  /** D14: the vendored Issues mirror is disarmed (ghAuto:false) — the panel
   *  renders the Projects board drawer instead of the issues UI. */
  issuesDisarmed?: boolean;
}

export const PROJECT_STATUS_EVENT = 'dom-annotakit:project-status';
const POLL_MS = 20_000;

export function useProjectStatus(): { status: ProjectStatusShape | null } {
  const [status, setStatus] = useState<ProjectStatusShape | null>(null);

  useEffect(() => {
    let alive = true;
    const apply = (s: unknown): void => {
      if (s && typeof s === 'object' && (s as ProjectStatusShape).state) {
        if (alive) setStatus(s as ProjectStatusShape);
      }
    };
    const poll = (): void => {
      fetch(new URL('dom-annotakit-project.json', document.baseURI).href, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then(apply)
        .catch(() => undefined); /* static mode: the event source covers it */
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    const onEvent = (e: Event): void => apply((e as CustomEvent).detail);
    window.addEventListener(PROJECT_STATUS_EVENT, onEvent);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener(PROJECT_STATUS_EVENT, onEvent);
    };
  }, []);

  return { status };
}

/** The chip tooltip (P2-9): state, target, counts, last sync, last error,
 *  the REAL recovery path — the honest surface for "is sync on?". */
export function projectStatusTitle(s: ProjectStatusShape): string {
  const head =
    s.state === 'ok'
      ? `GH spec board: synced${s.projectUrl ? ` — ${s.projectUrl}` : ''}`
      : s.state === 'error'
        ? `GH spec board: ERROR${s.lastError ? ` — ${s.lastError}` : ''}`
        : `GH spec board: off${s.reason ? ` — ${s.reason}` : ''}`;
  const counts = s.state === 'ok' ? `\n${s.threads ?? 0} threads → ${s.items ?? 0} board items` : '';
  const last = s.lastSyncAt ? `\nlast sync: ${new Date(s.lastSyncAt).toLocaleString()}` : '';
  const recovery = s.state !== 'ok' && s.recovery ? `\nrecovery: ${s.recovery}` : '';
  return `${head}${counts}${last}${recovery}`;
}
