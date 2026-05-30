/**
 * Real A2UI catalog object built from our typed component definitions and
 * React renderer adapters. Uses @copilotkit/a2ui-renderer's createCatalog
 * directly. Single source of truth for both schema (system prompt) and
 * renderer registration.
 *
 * This catalog backs Surface Mode: components/A2uiOverlayLayer.tsx mounts it on
 * an A2UIProvider and renders each overlay through <A2UIRenderer surfaceId=…/>.
 * The default hot path still flows through CopilotKit AG-UI tool calls into the
 * direct React renderer (OverlayLayer); both read the one overlays state.
 */
"use client";
import { createCatalog, type CatalogDefinitions } from "@copilotkit/a2ui-renderer";
import { catalogDefinitions } from "./catalog";

import MetricsPanel from "@/components/overlays/MetricsPanel";
import Timeline from "@/components/overlays/Timeline";
import LowerThird from "@/components/overlays/LowerThird";
import ProgressBar from "@/components/overlays/ProgressBar";
import KeywordHighlight from "@/components/overlays/KeywordHighlight";
import FloatingChart from "@/components/overlays/FloatingChart";
import ChatBubble from "@/components/overlays/ChatBubble";
import Letterbox from "@/components/overlays/Letterbox";
import Ticker from "@/components/overlays/Ticker";
import LiveBadge from "@/components/overlays/LiveBadge";
import StatRing from "@/components/overlays/StatRing";
import BigCounter from "@/components/overlays/BigCounter";

// Cast at the boundary: project zod (v4) vs A2UI's bundled zod (v3). Same
// runtime shape, different branded TS types. See catalog-schema.ts for context.
const definitions = catalogDefinitions as unknown as CatalogDefinitions;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adapt = <P,>(C: React.ComponentType<P>) => ({ props }: { props: any }) => <C {...props} />;

export const capturiaCatalog = createCatalog(
  definitions,
  {
    MetricsPanel: adapt(MetricsPanel),
    Timeline: adapt(Timeline),
    LowerThird: adapt(LowerThird),
    ProgressBar: adapt(ProgressBar),
    KeywordHighlight: adapt(KeywordHighlight),
    FloatingChart: adapt(FloatingChart),
    ChatBubble: adapt(ChatBubble),
    Letterbox: adapt(Letterbox),
    Ticker: adapt(Ticker),
    LiveBadge: adapt(LiveBadge),
    StatRing: adapt(StatRing),
    BigCounter: adapt(BigCounter),
  },
  // includeBasicCatalog merges A2UI's built-in primitives (Row, Column, List,
  // Divider, Text, Card, …) into this catalog alongside the 12 Capturia
  // overlays. It is purely additive (non-breaking for the single-leaf Surface
  // Mode path). Agent-authored surfaces (the render_surface tool) compose
  // branded Capturia leaves inside the transparent layout primitives; the
  // sanitizer in lib/a2ui-validate.ts whitelists only Row/Column/List/Divider so
  // the off-brand Material-styled Card/Text/Button are never rendered live.
  { catalogId: "capturia", includeBasicCatalog: true }
);
