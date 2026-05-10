/**
 * Real A2UI catalog object built from our typed component definitions and
 * React renderer adapters. Uses @copilotkit/a2ui-renderer's createCatalog
 * directly — single source of truth for both schema (system prompt) and
 * renderer registration.
 *
 * This catalog is currently exposed for future <A2UIRenderer surfaceId=…/>
 * use; the runtime hot path still flows through CopilotKit AG-UI tool calls
 * for stability.
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

// Cast at the boundary: project zod (v4) vs A2UI's bundled zod (v3) — same
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
  { catalogId: "capturia" }
);
