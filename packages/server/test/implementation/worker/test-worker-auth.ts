import { WorkerEntrypoint } from "cloudflare:workers";
import { SignJWT } from "jose";
import { StreamDO } from "../../../src/http/worker";
import { createStreamWorker } from "../../../src/http/worker";
import type { BaseEnv } from "../../../src/http/worker";

import { parseStreamPathFromUrl } from "../../../src/http/shared/stream-path";

// ============================================================================
// Test JWT infrastructure
// ============================================================================

const TEST_SIGNING_SECRET = "test-signing-secret-for-auth-tests";
const SECRET_KEY = new TextEncoder().encode(TEST_SIGNING_SECRET);

// Production handler with full auth middleware chain
const handler = createStreamWorker<BaseEnv>();

const registeredProjects = new Set<string>();

async function ensureProject(kv: KVNamespace, projectId: string): Promise<void> {
  if (registeredProjects.has(projectId)) return;
  await kv.put(
    projectId,
    JSON.stringify({
      signingSecrets: [TEST_SIGNING_SECRET],
      corsOrigins: ["*"],
    }),
  );
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
// Test Worker (reader key / auth tests)
// ============================================================================

// Same pattern as test-worker.ts: full production auth with injected tokens.
// This worker exists for reader key tests that use a separate KV namespace.
export default class TestCoreWorkerAuth extends WorkerEntrypoint<BaseEnv> {
  async fetch(request: Request): Promise<Response> {
    const parsed = parseStreamPathFromUrl(new URL(request.url).pathname);
    await ensureProject(this.env.REGISTRY, parsed?.projectId ?? "_default");

    const debugAction = request.headers.get("X-Debug-Action");
    if (debugAction) {
      return this.#handleDebugAction(debugAction, request);
    }

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
    const url = new URL(request.url);
    const pathMatch = /^\/v1\/stream\/(.+)$/.exec(url.pathname);
    if (!pathMatch) return new Response("not found", { status: 404 });
    const raw = pathMatch[1];
    const i = raw.indexOf("/");
    const doKey = i === -1 ? `_default/${raw}` : `${raw.slice(0, i)}/${raw.slice(i + 1)}`;

    if (action === "rotate-reader-key") {
      const result = await this.rotateReaderKey(doKey);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("unknown action", { status: 400 });
  }

  async rotateReaderKey(doKey: string): Promise<{ readerKey: string }> {
    const readerKey = `rk_${crypto.randomUUID().replace(/-/g, "")}`;
    const existing = (await this.env.REGISTRY.get(doKey, "json")) as Record<string, unknown> | null;
    await this.env.REGISTRY.put(doKey, JSON.stringify({ ...existing, readerKey }));
    return { readerKey };
  }
}

export { StreamDO };
