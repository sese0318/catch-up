import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);

vi.mock("next/server", () => ({
  connection: async () => {
    calls.push("connection");
  },
}));

vi.mock("@/lib/server/handle-card", () => ({
  handleCardRequest: async (req: Request) => {
    calls.push(`card ${req.method}`);
    return new Response("event: done\ndata: {}\n\n", { headers: { "Content-Type": "text/event-stream" } });
  },
  handleHealthRequest: () => {
    calls.push("health");
    return Response.json({ ok: true });
  },
}));

import * as cardRoute from "./card/route";
import * as healthRoute from "./health/route";

describe("route files", () => {
  it("POST /api/card hands the request to handleCardRequest on the default Node runtime", async () => {
    calls.length = 0;
    const res = await cardRoute.POST(new Request("http://localhost/api/card", { method: "POST", body: "x" }));
    expect(calls).toEqual(["card POST"]);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(cardRoute.maxDuration).toBe(60);
    expect(cardRoute).not.toHaveProperty("runtime"); // Cache Components rejects a runtime export
    expect(cardRoute).not.toHaveProperty("GET");
  });

  it("GET /api/health awaits connection() before reading anything", async () => {
    calls.length = 0;
    const res = await healthRoute.GET();
    expect(calls).toEqual(["connection", "health"]);
    expect(await res.json()).toEqual({ ok: true });
    expect(healthRoute).not.toHaveProperty("runtime");
  });
});
