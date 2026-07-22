// Current-period usage for the hosted tier (issue #10 slice 4): what feeds
// the in-app hours meter. Read-only and authenticated EXACTLY like the proxy
// (same Ed25519 JWT verification, same token slots, same 401/503 shapes), so
// holding a valid Capturia JWT is the one and only way to read a customer's
// counters, and no auth state exists here that the proxy does not have.
//
// Static sibling of the [[...slug]] catch-all: predefined segments win over
// the dynamic route, so GET /api/hosted/usage lands here while every proxy
// POST keeps hitting the catch-all. Tokens are the wire unit (the invisible
// enforcement detail); turning them into hours is the client's job
// (lib/hosted-hours.ts), so customer-facing surfaces can keep the
// hours-never-tokens rule without the server guessing at copy.

import { jwtPublicKeyFromEnv, verifyHostedJwt } from "@/lib/hosted/jwt";
import { getHostedBackend } from "@/lib/hosted/backend";
import {
  gateConfigFromEnv,
  monthEndMs,
  readFlashMonthlyUsage,
  readMonthlyUsage,
} from "@/lib/hosted/gate";
import { hostedTokenFromRequest } from "@/lib/hosted/proxy";

// Usage counters move with every generation; nothing here is cacheable.
export const dynamic = "force-dynamic";

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request): Promise<Response> {
  const publicKey = jwtPublicKeyFromEnv(process.env);
  if (!publicKey) {
    return jsonError(503, "Hosted tier is not configured on this deployment.");
  }
  const verdict = verifyHostedJwt(hostedTokenFromRequest(request), publicKey);
  if (!verdict.ok) return jsonError(401, verdict.error);
  const customer = verdict.claims.sub;

  let backend;
  try {
    backend = await getHostedBackend(process.env);
  } catch {
    return jsonError(503, "Hosted tier state backend is not configured.");
  }

  const cfg = gateConfigFromEnv(process.env);
  const now = Date.now();
  const [tokensUsed, flashTokensUsed] = await Promise.all([
    readMonthlyUsage(backend.run, customer, now),
    readFlashMonthlyUsage(backend.run, customer, now),
  ]);
  return Response.json(
    {
      tokensUsed,
      monthlyTokenBudget: cfg.monthlyTokenBudget,
      flashTokensUsed,
      flashTokenBudget: cfg.flashMonthlyTokenBudget,
      // First instant of next month (UTC): when every counter above resets.
      periodEnd: monthEndMs(now),
    },
    { headers: { "cache-control": "no-store" } }
  );
}
