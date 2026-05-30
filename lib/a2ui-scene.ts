// Translation from Capturia's OverlaySpec state into A2UI v0.9 protocol messages
// (the @a2ui/web_core wire format consumed by MessageProcessor.processMessages).
//
// Surface Mode renders each overlay through the REAL A2UI pipeline instead of the
// direct React switch in components/overlays. One surface per overlay keeps the
// model simple: the surface id IS the overlay id, and the single root component
// (id "root", required by the @copilotkit/a2ui-renderer adapter) is the overlay
// itself. Props ride as sibling keys of `component`/`id` (the envelope is
// passthrough), exactly matching what each catalog renderer receives via adapt().
//
// This file is pure data (no React, no package import) so it is safe to import
// from anywhere and trivial to unit-reason about.

import type { OverlaySpec } from "./types";

// The leaf builders below render ONE catalog component rooted at "root"; they
// must never receive an authored Surface (whose props are a component tree, not
// leaf props). Excluding it makes misuse a compile error, not a runtime "render
// a non-existent 'Surface' component" failure.
type LeafOverlay = Exclude<OverlaySpec, { type: "Surface" }>;

// Must match the catalogId passed to createCatalog() in lib/a2ui-catalog.tsx,
// which becomes the Catalog id the MessageProcessor looks up on createSurface.
export const CATALOG_ID = "capturia";

type A2uiMessage = Record<string, unknown>;

// The single component node for an overlay. id is fixed to "root" because the
// renderer mounts the surface entry point at id "root"; `component` is the
// catalog type name; every other key is a literal prop resolved straight to the
// React renderer (our schemas use plain values, so no data binding needed).
function rootComponent(overlay: LeafOverlay): A2uiMessage {
  return {
    id: "root",
    component: overlay.type,
    ...(overlay.props as Record<string, unknown>),
  };
}

// Create the surface and populate its root in one batch (order matters:
// createSurface must precede updateComponents for the same surfaceId).
export function buildOverlayCreate(overlay: LeafOverlay): A2uiMessage[] {
  return [
    {
      version: "v0.9",
      createSurface: { surfaceId: overlay.id, catalogId: CATALOG_ID },
    },
    {
      version: "v0.9",
      updateComponents: {
        surfaceId: overlay.id,
        components: [rootComponent(overlay)],
      },
    },
  ];
}

// Replace the root component's props in place (the processor updates an existing
// id in place, or recreates it if the `component` type changed).
export function buildOverlayUpdate(overlay: LeafOverlay): A2uiMessage {
  return {
    version: "v0.9",
    updateComponents: {
      surfaceId: overlay.id,
      components: [rootComponent(overlay)],
    },
  };
}

export function buildOverlayDelete(surfaceId: string): A2uiMessage {
  return { version: "v0.9", deleteSurface: { surfaceId } };
}

// --- Agent-authored surfaces (the render_surface tool) ----------------------
// Unlike the leaf overlays above (one catalog component rooted at "root"), an
// authored surface carries a whole component TREE the model composed. The flat
// node list (root id "root", already sanitized by lib/a2ui-validate.ts) is fed
// straight into updateComponents.

type SurfaceOverlay = { id: string; props: { components: A2uiMessage[] } };

export function buildSurfaceCreate(overlay: SurfaceOverlay): A2uiMessage[] {
  return [
    {
      version: "v0.9",
      createSurface: { surfaceId: overlay.id, catalogId: CATALOG_ID },
    },
    {
      version: "v0.9",
      updateComponents: {
        surfaceId: overlay.id,
        components: overlay.props.components,
      },
    },
  ];
}

// Re-author = delete + recreate, NOT updateComponents. updateComponents merges
// by id and never removes dropped nodes, so updating in place would leak orphan
// (and possibly stale-prop) components from the previous tree. Surfaces are
// small, so a clean teardown + rebuild is cheap and correct. deleteSurface of a
// not-yet-created surface is a no-op, so this is also safe on a first push.
export function buildSurfaceUpdate(overlay: SurfaceOverlay): A2uiMessage[] {
  return [buildOverlayDelete(overlay.id), ...buildSurfaceCreate(overlay)];
}
