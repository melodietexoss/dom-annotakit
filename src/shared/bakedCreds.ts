/**
 * dom-annotakit — baked credentials (PUBLIC-RELEASE form: none).
 *
 * Public builds carry NO baked token: configure via the standard ladder —
 * shell env (ANNOTAKIT_GH_TOKEN) > .env (see .env.example) > runtime panel
 * settings — or run the honest no-credential local mode (the panel shows the
 * configuration doors when a sync needs a token). See README.md.
 */
export const BAKED_GH_TOKEN: string = '';

/**
 * The default GH Projects (v2) board this kit syncs to. Empty in the public
 * release — per-instance annotakit.config.json "project.target" (or the
 * ANNOTAKIT_PROJECT_URL env) sets it.
 */
export const BAKED_PROJECT_TARGET: string = '';
