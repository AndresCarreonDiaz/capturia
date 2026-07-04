"use client";
import { A2UIProvider } from "@copilotkit/a2ui-renderer";
import OverlayLayer from "@/components/OverlayLayer";
import A2uiOverlay from "@/components/A2uiOverlay";
import { capturiaCatalog } from "@/lib/a2ui-catalog";
import type { OverlaySpec } from "@/lib/types";

// A user interaction with an authored surface (a tap on an ActionButton),
// flattened from the renderer's A2UIClientEventMessage.userAction.
export interface SurfaceAction {
  name: string;
  surfaceId: string;
  sourceComponentId?: string;
  context?: Record<string, unknown>;
}

interface Props {
  overlays: OverlaySpec[];
  // When set, a tap on an interactive leaf (ActionButton) inside an authored
  // surface fires this. The studio re-injects it as an "[ACTION] <name>" user
  // turn, closing the agent<->surface loop. Omitted for the leaf-overlay
  // (Surface Mode) host, which never contains interactive leaves: the
  // placement tools and the deck path reject surface-only types via
  // isPlaceableOverlayType (lib/catalog.ts), so an ActionButton can only
  // exist inside an authored surface, where this handler is wired.
  onSurfaceAction?: (action: SurfaceAction) => void;
}

/**
 * A2UI host layer, mounted twice by the studio:
 *   1. Surface Mode entry point: drop-in alternative to <OverlayLayer> that
 *      renders the SAME leaf-overlay state through the real A2UI runtime.
 *   2. Always-on dedicated host for agent-authored render_surface trees, with
 *      onSurfaceAction wired so ActionButton taps come back as [ACTION] turns.
 * One A2UIProvider holds the MessageProcessor + the registered capturiaCatalog
 * (NOTE: the provider captures the catalog on first render and never refreshes
 * it, so the catalog must stay a module-level constant, never built per
 * render), and each overlay is an independent A2UI surface (see A2uiOverlay).
 * The overlays array stays the single source of truth, so every existing path
 * (the AG-UI tools, deck cue matching, compose_scene, render_surface, voice)
 * drives both render modes unchanged.
 *
 * This module statically imports the A2UIProvider/A2UIRenderer render path,
 * which is client-only (createContext at module load), so the studio loads it
 * via next/dynamic ssr:false; the renderer never executes on the server and is
 * not in the marketing bundle. (The catalog object itself is built at module
 * load in lib/a2ui-catalog.tsx and is imported by the studio regardless of
 * Surface Mode; that is harmless, since nothing in it touches the DOM and
 * createContext is server-safe in React 19.)
 */
export default function A2uiOverlayLayer({ overlays, onSurfaceAction }: Props) {
  return (
    <A2UIProvider
      catalog={capturiaCatalog}
      // The provider builds its MessageProcessor once but reads onAction through
      // a ref refreshed each render, so an inline handler is safe (no surface
      // teardown). A tap arrives as { userAction: { name, surfaceId, ... } }.
      onAction={
        onSurfaceAction
          ? (msg) => {
              const ua = msg.userAction;
              if (ua?.name) {
                onSurfaceAction({
                  name: ua.name,
                  surfaceId: ua.surfaceId,
                  sourceComponentId: ua.sourceComponentId,
                  context: ua.context,
                });
              } else if (ua) {
                // actionName is min(1) at the schema, so this should be
                // unreachable; if it ever fires, say so instead of silently
                // swallowing the tap.
                console.warn("capturia: surface action with empty name ignored");
              }
            }
          : undefined
      }
    >
      <OverlayLayer
        overlays={overlays}
        renderItem={(overlay, { exiting, enterIndex }) => (
          <A2uiOverlay overlay={overlay} exiting={exiting} enterIndex={enterIndex} />
        )}
      />
    </A2UIProvider>
  );
}
