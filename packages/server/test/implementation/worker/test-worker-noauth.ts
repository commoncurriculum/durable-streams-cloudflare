import { WorkerEntrypoint } from "cloudflare:workers";
import { StreamDO } from "../../../src/http/worker";
import { createStreamWorker } from "../../../src/http/worker";
import type { BaseEnv } from "../../../src/http/worker";
import { createProject } from "../../../src/storage/registry";
import { parseStreamPathFromUrl } from "../../../src/http/shared/stream-path";

// ============================================================================
// Auth rejection test worker
// ============================================================================
//
// This worker is designed for testing that unauthenticated requests are
// properly rejected with 401. It:
// 1. Registers projects in KV so the auth middleware can look up signing secrets
// 2. Does NOT inject JWT tokens — requests pass through as-is
// 3. Delegates to the full production auth middleware chain

const TEST_SIGNING_SECRET = "test-signing-secret-for-auth-rejection-tests";

const handler = createStreamWorker<BaseEnv>();

const registeredProjects = new Set<string>();

async function ensureProject(kv: KVNamespace, projectId: string): Promise<void> {
  if (registeredProjects.has(projectId)) return;
  await createProject(kv, projectId, TEST_SIGNING_SECRET, {
    corsOrigins: ["*"],
  });
  registeredProjects.add(projectId);
}

export default class TestWorkerNoAuth extends WorkerEntrypoint<BaseEnv> {
  async fetch(request: Request): Promise<Response> {
    const parsed = parseStreamPathFromUrl(new URL(request.url).pathname);
    await ensureProject(this.env.REGISTRY, parsed?.projectId ?? "_default");

    // No token injection — let the auth middleware reject unauthenticated requests
    return handler.fetch!(
      request as unknown as Request<unknown, IncomingRequestCfProperties>,
      this.env,
      this.ctx,
    );
  }
}

export { StreamDO };
