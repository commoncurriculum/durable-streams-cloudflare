import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { ZERO_OFFSET } from "../../../src/http/v1/streams/shared/offsets";
import { createClient, uniqueStreamId } from "../helpers";

// The secret test/implementation/test-worker.ts registers for every project.
const SECRET_KEY = new TextEncoder().encode("test-signing-secret-for-implementation-tests");

function token(scope: string, streamId?: string): Promise<string> {
  return new SignJWT(streamId === undefined ? { scope } : { scope, stream_id: streamId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("test-user")
    .setExpirationTime("1h")
    .sign(SECRET_KEY);
}

describe("a token with stream_id", () => {
  it("reads and writes its own stream, and no other", async () => {
    const client = createClient();
    const own = uniqueStreamId("scoped-own");
    const other = uniqueStreamId("scoped-other");
    for (const streamId of [own, other]) {
      const created = await fetch(client.streamUrl(streamId), {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "secret",
      });
      expect(created.status).toBe(201);
    }

    const write = `Bearer ${await token("write", own)}`;
    const read = `Bearer ${await token("read", own)}`;
    const append = (streamId: string) =>
      fetch(client.streamUrl(streamId), {
        method: "POST",
        headers: { "Content-Type": "text/plain", Authorization: write },
        body: "more",
      });
    const get = (streamId: string) =>
      fetch(client.streamUrl(streamId, { offset: ZERO_OFFSET }), {
        headers: { Authorization: read },
      });

    expect((await append(own)).status).toBe(204);
    const ownRead = await get(own);
    expect(ownRead.status).toBe(200);
    expect(await ownRead.text()).toBe("secretmore");

    expect((await append(other)).status).toBe(403);
    expect((await get(other)).status).toBe(403);

    // A token without stream_id is for every stream in its project.
    const anyStream = await fetch(client.streamUrl(other, { offset: ZERO_OFFSET }), {
      headers: { Authorization: `Bearer ${await token("read")}` },
    });
    expect(anyStream.status).toBe(200);
    expect(await anyStream.text()).toBe("secret");
  });
});
