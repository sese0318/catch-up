// POST /api/card. The raw WAV (or a Route A transcript) in, an event stream out. Node runtime, the
// default (no runtime export, because Cache Components is on). Keys are read only on the server.
import { handleCardRequest } from "@/lib/server/handle-card";

// The server stops providers at 19 s and the client at 20 s. 60 s leaves room for a slow upload.
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  return handleCardRequest(request);
}
