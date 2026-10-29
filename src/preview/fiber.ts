/**
 * dom-annotakit — fiber stub (COPY-MAP preview row: fiber.ts REPLACE).
 *
 * Upstream inspected the React fiber graph (`__reactFiber$*` instance-key walk,
 * `_debugStack` frames, sourcemap VLQ correction) to enrich the composer with
 * `component:` / `jsx:` rows. A SingleFile capture has NO React — the pages are
 * serialized production DOM. The null stub is exactly the layer's already-
 * supported "no component meta" state (the frozen-pin shape): the composer
 * keeps its `element:` row (describe.ts, pure DOM), component/jsx rows
 * vanish, and ThreadCard's jsx/chain rows go empty naturally.
 *
 * Consumers: layer.tsx only (inspectComponent at the composer-meta effect +
 * submitThread; correctSource via the correctComponent helper — unreachable
 * while inspectComponent is null, typed so the import stays checkable).
 */

import type { ComponentRef, ComponentSource } from '../shared/types';

/** Always null — no React fiber graph exists in a captured document. */
export const inspectComponent = (_el: HTMLElement): ComponentRef | null => null;

/**
 * Never invoked (correctComponent only runs when inspectComponent returned a
 * ref with a source). Null per the COPY-MAP stub shape; cast to the call-site
 * signature so the layer's import typechecks unchanged.
 */
export const correctSource = null as unknown as (source: ComponentSource) => Promise<ComponentSource>;
