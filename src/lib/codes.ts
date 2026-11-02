// Error codes and provider failures. Shared by the card schema and the wire protocol, which
// re-exports everything here, so import these from "@/lib/protocol" as before. This file has
// no imports from the app, so card/schema.ts can use ErrorCode without an import cycle.
import { z } from "zod";

/** Why a provider gave up. Never carries content. */
export const PROVIDER_FAILURES = [
  "not_configured",
  "bad_input",
  "http",
  "rate_limited",
  "timeout",
  "no_token",
  "bad_json",
  "refused",
  "length",
  "empty",
  "aborted",
] as const;
export const ProviderFailure = z.enum(PROVIDER_FAILURES);
export type ProviderFailure = z.infer<typeof ProviderFailure>;

export const ERROR_CODES = [
  "bad_request",
  "bad_audio",
  "too_large",
  "rate_limited",
  "daily_cap",
  "live_off",
  "not_configured",
  "mock_refused",
  "timeout",
  "provider_error",
  "server_error",
  "offline", // client only
  "network", // client only
  "aborted", // client only. The press ended without Esc or Cancel, for example dispose() mid-press
] as const;
export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;
