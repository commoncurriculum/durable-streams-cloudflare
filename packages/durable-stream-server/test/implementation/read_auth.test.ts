import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { startWorker } from "./worker_harness";
import { ZERO_OFFSET } from "../../src/protocol/offsets";

function signSessionJwt(secret: string, sessionId: string, ttlSeconds = 60): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      session_id: sessionId,
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

describe("read auth", () => {
  it("requires a session JWT and subscription membership", async () => {
    const secret = "test-read-secret";
    const handle = await startWorker({ vars: { READ_JWT_SECRET: secret } });
    const streamId = `read-auth-${randomUUID()}`;
    const streamUrl = `${handle.baseUrl}/v1/stream/${streamId}`;

    try {
      const create = await fetch(streamUrl, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
      });
      expect([200, 201]).toContain(create.status);

      const sessionResp = await fetch(`${handle.baseUrl}/v1/sessions`, { method: "POST" });
      expect(sessionResp.status).toBe(201);
      const sessionPayload = (await sessionResp.json()) as { sessionId: string };

      const subscribe = await fetch(`${handle.baseUrl}/v1/subscriptions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sessionPayload.sessionId, streamId }),
      });
      expect(subscribe.status).toBe(204);

      const missingAuth = await fetch(`${streamUrl}?offset=${ZERO_OFFSET}`);
      expect(missingAuth.status).toBe(401);
      expect(missingAuth.headers.get("Access-Control-Allow-Origin")).toBe("*");

      const otherSession = signSessionJwt(secret, `other-${randomUUID()}`);
      const forbidden = await fetch(`${streamUrl}?offset=${ZERO_OFFSET}`, {
        headers: { Authorization: `Bearer ${otherSession}` },
      });
      expect(forbidden.status).toBe(403);

      const token = signSessionJwt(secret, sessionPayload.sessionId);
      const allowed = await fetch(`${streamUrl}?offset=${ZERO_OFFSET}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(allowed.status).toBe(200);
    } finally {
      await handle.stop();
    }
  });
});
