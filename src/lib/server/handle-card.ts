// Request handlers behind src/app/api/card/route.ts and src/app/api/health/route.ts. Server lane.
// Plain Web Request and Response, so vitest and the eval runner can call them without Next.
import type { CardHandlerDeps, HealthHandlerDeps } from "../providers/types";

/**
 * POST /api/card. Decodes X-CatchUp-Meta, plans routes, applies the per-IP limit and the daily
 * cap, checks the body (checkClipWav or a transcript), then streams stage, card or error, and
 * done. Errors found before streaming use errorEventResponse. Logs one PressLogEntry per press.
 */
export async function handleCardRequest(req: Request, deps?: CardHandlerDeps): Promise<Response> {
  void req;
  void deps;
  throw new Error("not implemented");
}

/** GET /api/health as a HealthResponse. Never includes keys. */
export function handleHealthRequest(deps?: HealthHandlerDeps): Response {
  void deps;
  throw new Error("not implemented");
}
