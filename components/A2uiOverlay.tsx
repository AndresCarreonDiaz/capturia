"use client";
import { useLayoutEffect, useMemo } from "react";
import { A2UIRenderer, useA2UI } from "@copilotkit/a2ui-renderer";
import type { OverlaySpec } from "@/lib/types";
import { overlayAnimProps } from "@/components/overlays";
import Letterbox from "@/components/overlays/Letterbox";
import {
  buildOverlayCreate,
  buildOverlayUpdate,
  buildOverlayDelete,
  buildSurfaceCreate,
  buildSurfaceUpdate,
} from "@/lib/a2ui-scene";

interface Props {
  overlay: OverlaySpec;
  exiting?: boolean;
  enterIndex?: number;
}

/**
 * Surface Mode leaf renderer: renders ONE overlay through the genuine A2UI v0.9
 * pipeline (its own surface, rooted at the overlay's catalog component) instead
 * of the direct React switch. The shared A2UIProvider (mounted by
 * A2uiOverlayLayer) owns the MessageProcessor + capturiaCatalog; this host just
 * pushes create/update/delete messages for its surface and mounts an
 * <A2UIRenderer> for it. The enter/exit/stagger wrapper is identical to the
 * direct path so the two render modes look the same.
 */
export default function A2uiOverlay({ overlay, exiting = false, enterIndex = 0 }: Props) {
  const { processMessages, getSurface } = useA2UI();

  // Letterbox is a full-screen cinematic effect, not a positioned card. Its
  // slide in/out is driven by an `exiting` flag that the A2UI catalog
  // passthrough would drop (only declared props survive), so, exactly like the
  // direct renderer, it stays a direct component and manages no A2UI surface.
  // The other 11 overlays render through the real A2UI pipeline below.
  const isLetterbox = overlay.type === "Letterbox";

  // A stable signature of the renderable content, so prop/type edits re-push.
  const sig = useMemo(
    () => `${overlay.type}:${JSON.stringify(overlay.props)}`,
    [overlay.type, overlay.props]
  );

  // Create-or-update the surface synchronously before paint. createSurface
  // throws if the surface already exists, so guard with getSurface; the
  // provider also swallows processMessages errors, but guarding keeps the
  // console clean and is correct under StrictMode's double-invoke.
  useLayoutEffect(() => {
    if (isLetterbox) return;
    const exists = !!getSurface(overlay.id);
    if (overlay.type === "Surface") {
      // Authored surface: full tree. Re-author = delete + recreate (see
      // buildSurfaceUpdate) so dropped nodes don't leak in the A2UI model.
      processMessages(exists ? buildSurfaceUpdate(overlay) : buildSurfaceCreate(overlay));
    } else if (exists) {
      processMessages([buildOverlayUpdate(overlay)]);
    } else {
      processMessages(buildOverlayCreate(overlay));
    }
    // overlay.id + sig capture every renderable change (sig includes props, so a
    // re-authored tree re-pushes); processMessages/getSurface are stable refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay.id, sig, isLetterbox]);

  // Tear the surface down once this overlay is fully gone (OverlayLayer keeps
  // the node mounted through the exit animation, then unmounts → delete fires).
  useLayoutEffect(() => {
    if (isLetterbox) return;
    return () => {
      processMessages([buildOverlayDelete(overlay.id)]);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay.id, isLetterbox]);

  if (overlay.type === "Letterbox") {
    return <Letterbox {...overlay.props} exiting={exiting} />;
  }

  const { className, style } = overlayAnimProps(overlay.type, exiting, enterIndex);

  // Authored surfaces root in a basic Row/Column, which set `width:100%`. The
  // positioned wrapper is absolute with no width, so without a bound that 100%
  // resolves against the full-screen overlay layer and the surface stretches
  // edge to edge. Constrain it to a capped max-content box so it sizes to its
  // composed content like the leaf overlays do.
  if (overlay.type === "Surface") {
    return (
      <div className={className} style={style}>
        <div style={{ width: "max-content", maxWidth: "min(80vw, 560px)" }}>
          <A2UIRenderer surfaceId={overlay.id} />
        </div>
      </div>
    );
  }

  return (
    <div className={className} style={style}>
      <A2UIRenderer surfaceId={overlay.id} />
    </div>
  );
}
