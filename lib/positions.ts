import type { OverlayPosition } from "./types";

export const POSITION_CLASSES: Record<OverlayPosition, string> = {
  "top-left": "top-4 left-4",
  "top-right": "top-4 right-4",
  "top-center": "top-4 left-1/2 -translate-x-1/2",
  "center-left": "top-1/2 left-4 -translate-y-1/2",
  "center-right": "top-1/2 right-4 -translate-y-1/2",
  "bottom-left": "bottom-20 left-4",
  "bottom-right": "bottom-20 right-4",
  "bottom-center": "bottom-20 left-1/2 -translate-x-1/2",
  "full-bottom": "bottom-20 left-0 right-0 px-4",
};
