// GET /api/health. Which live routes have keys, whether live calls are on, and the public limits.
// Never returns key material.
import { connection } from "next/server";
import { handleHealthRequest } from "@/lib/server/handle-card";

export async function GET(): Promise<Response> {
  await connection(); // run per request under Cache Components, never prerendered at build time
  return handleHealthRequest();
}
