import { WorkerEntrypoint } from "cloudflare:workers";
import { SignJWT } from "jose";
import { type } from "arktype";
import { StreamDO } from "../../src/http/worker";
import { createStreamWorker } from "../../src/http/worker";
import type { BaseEnv } from "../../src/http/worker";
import { createProject } from "../../src/storage/registry";
import { parseStreamPathFromUrl } from "../../src/http/shared/stream-path";

// ============================================================================
// Test JWT infrastructure
// ============================================================================

const TEST_SIGNING_SECRET = "test-signing-secret-for-implementation-tests";
const SECRET_KEY = new TextEncoder().encode(TEST_SIGNING_SECRET);

// Production handler with full auth middleware (pathParsing → CORS →
// authentication → authorization → timing → edgeCache). Created at module
// scope so the in-flight coalescing Map is shared across all requests.
const handler = createStreamWorker<BaseEnv>();

// Register projects on demand — subscription integration tests use
// "test-project", implementation tests use "_default" (implicit).
const registeredProjects = new Set<string>();

async function ensureProject(kv: KVNamespace, projectId: string): Promise<void> {
  if (registeredProjects.has(projectId)) return;
  await createProject(kv, projectId, TEST_SIGNING_SECRET, {
    corsOrigins: ["*"],
  });
  registeredProjects.add(projectId);
}

async function generateTestToken(scope = "manage"): Promise<string> {
  return new SignJWT({ scope })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("test-user")
    .setExpirationTime("1h")
    .sign(SECRET_KEY);
}

// ============================================================================
// Validation
// ============================================================================

const putStreamOptions = type({
  "expiresAt?": "number",
  "body?": "ArrayBuffer",
  "contentType?": "string",
});

// ============================================================================
// Test Worker
// ============================================================================

// Uses the full production auth middleware chain. On each request the worker:
// 1. Registers the _default project with a known signing secret (idempotent)
// 2. Injects a real, properly-signed JWT token for requests without Authorization
// 3. Delegates to the production handler which validates the token normally
//
// Conformance tests (external package) cannot add headers, so the worker
// provides real tokens on their behalf. Implementation tests also get tokens
// injected — the production auth middleware validates every request.
export default class TestCoreWorker extends WorkerEntrypoint<BaseEnv> {
  async fetch(request: Request): Promise<Response> {
    // Register the project for this URL so auth middleware can look it up
    const parsed = parseStreamPathFromUrl(new URL(request.url).pathname);
    await ensureProject(this.env.REGISTRY, parsed?.projectId ?? "_default");

    // Debug actions bypass the HTTP handler entirely (direct DO RPC)
    const debugAction = request.headers.get("X-Debug-Action");
    if (debugAction) {
      return this.#handleDebugAction(debugAction, request);
    }

    // Inject a valid JWT for requests without an Authorization header
    if (!request.headers.has("Authorization")) {
      const token = await generateTestToken("manage");
      const headers = new Headers(request.headers);
      headers.set("Authorization", `Bearer ${token}`);
      request = new Request(request, { headers });
    }

    return handler.fetch!(
      request as unknown as Request<unknown, IncomingRequestCfProperties>,
      this.env,
      this.ctx,
    );
  }

  async #handleDebugAction(action: string, request: Request): Promise<Response> {
    // Coverage collection is global — not scoped to a stream path
    if (action === "coverage") {
      const coverage = (globalThis as Record<string, unknown>).__coverage__;
      if (!coverage) {
        return new Response(
          JSON.stringify({ error: "no coverage data (worker not instrumented)" }),
          {
            status: 404,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify(coverage), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const url = new URL(request.url);
    const pathMatch = /^\/v1\/stream\/(.+)$/.exec(url.pathname);
    if (!pathMatch) return new Response("not found", { status: 404 });
    const raw = pathMatch[1];
    const i = raw.indexOf("/");
    const doKey = i === -1 ? `_default/${raw}` : `${raw.slice(0, i)}/${raw.slice(i + 1)}`;

    const streamId = doKey.split("/").slice(1).join("/");
    const stub = this.env.STREAMS.getByName(doKey);

    if (action === "compact-retain") {
      await stub.testForceCompact(streamId, true);
      return new Response(null, { status: 204 });
    }
    if (action === "compact") {
      await stub.testForceCompact(streamId, false);
      return new Response(null, { status: 204 });
    }
    if (action === "ops-count") {
      const count = await stub.testGetOpsCount(streamId);
      return new Response(JSON.stringify({ count }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (action === "producer-age") {
      const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (
        !payload ||
        typeof payload.producerId !== "string" ||
        typeof payload.lastUpdated !== "number"
      ) {
        return new Response("invalid payload", { status: 400 });
      }
      const ok = await stub.testSetProducerAge(streamId, payload.producerId, payload.lastUpdated);
      return ok ? new Response(null, { status: 204 }) : new Response("not found", { status: 404 });
    }
    if (action === "rotate-reader-key") {
      const result = await this.rotateReaderKey(doKey);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (action === "truncate-latest") {
      const ok = await stub.testTruncateLatestSegment(streamId);
      return ok ? new Response(null, { status: 204 }) : new Response("failed", { status: 400 });
    }
    return new Response("unknown action", { status: 400 });
  }

  // ============================================================================
  // RPC methods (used by subscription integration tests via service bindings)
  // These bypass the HTTP handler — they call the DO directly.
  // ============================================================================

  async rotateReaderKey(doKey: string): Promise<{ readerKey: string }> {
    const readerKey = `rk_${crypto.randomUUID().replace(/-/g, "")}`;
    const existing = (await this.env.REGISTRY.get(doKey, "json")) as Record<string, unknown> | null;
    await this.env.REGISTRY.put(doKey, JSON.stringify({ ...existing, readerKey }));
    return { readerKey };
  }

  async routeRequest(doKey: string, request: Request): Promise<Response> {
    const stub = this.env.STREAMS.getByName(doKey);
    return stub.routeStreamRequest(doKey, request);
  }

  async headStream(doKey: string): Promise<{
    ok: boolean;
    status: number;
    body: string | null;
    contentType: string | null;
  }> {
    const stub = this.env.STREAMS.getByName(doKey);
    const response = await stub.routeStreamRequest(
      doKey,
      new Request("https://internal/v1/stream", { method: "HEAD" }),
    );
    const body = response.ok ? null : await response.text();
    return {
      ok: response.ok,
      status: response.status,
      body,
      contentType: response.headers.get("Content-Type"),
    };
  }

  async putStream(
    doKey: string,
    options: { expiresAt?: number; body?: ArrayBuffer; contentType?: string },
  ): Promise<{ ok: boolean; status: number; body: string | null }> {
    const validated = putStreamOptions(options);
    if (validated instanceof type.errors) {
      return { ok: false, status: 400, body: validated.summary };
    }
    const headers: Record<string, string> = {};
    if (options.contentType) {
      headers["Content-Type"] = options.contentType;
    }
    if (options.expiresAt) {
      headers["Stream-Expires-At"] = new Date(options.expiresAt).toISOString();
    }
    const stub = this.env.STREAMS.getByName(doKey);
    const response = await stub.routeStreamRequest(
      doKey,
      new Request("https://internal/v1/stream", {
        method: "PUT",
        headers,
        body: options.body,
      }),
    );
    const body = response.ok ? null : await response.text();
    return { ok: response.ok, status: response.status, body };
  }

  async deleteStream(doKey: string): Promise<{ ok: boolean; status: number; body: string | null }> {
    const stub = this.env.STREAMS.getByName(doKey);
    const response = await stub.routeStreamRequest(
      doKey,
      new Request("https://internal/v1/stream", { method: "DELETE" }),
    );
    const body = response.ok ? null : await response.text();
    return { ok: response.ok, status: response.status, body };
  }

  async postStream(
    doKey: string,
    payload: ArrayBuffer,
    contentType: string,
    producerHeaders?: {
      producerId: string;
      producerEpoch: string;
      producerSeq: string;
    },
  ): Promise<{
    ok: boolean;
    status: number;
    nextOffset: string | null;
    upToDate: string | null;
    streamClosed: string | null;
    body: string | null;
  }> {
    const headers: Record<string, string> = { "Content-Type": contentType };
    if (producerHeaders) {
      headers["Producer-Id"] = producerHeaders.producerId;
      headers["Producer-Epoch"] = producerHeaders.producerEpoch;
      headers["Producer-Seq"] = producerHeaders.producerSeq;
    }
    const stub = this.env.STREAMS.getByName(doKey);
    const response = await stub.routeStreamRequest(
      doKey,
      new Request("https://internal/v1/stream", {
        method: "POST",
        headers,
        body: payload,
      }),
    );
    const body = response.ok ? null : await response.text();
    return {
      ok: response.ok,
      status: response.status,
      nextOffset: response.headers.get("Stream-Next-Offset"),
      upToDate: response.headers.get("Stream-Up-To-Date"),
      streamClosed: response.headers.get("Stream-Closed"),
      body,
    };
  }
}

export { StreamDO };
