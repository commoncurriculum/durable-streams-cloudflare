import { WorkerEntrypoint } from "cloudflare:workers";
import { createStreamWorker } from "./index";
import { StreamDO } from "./durable-object";
import { SubscriptionDO } from "../subscriptions/do";
import { EstuaryDO } from "../estuary/do";
import type { StreamIntrospection } from "./durable-object";
import type { BaseEnv } from "./index";
import {
  createProject,
  addSigningKey as registryAddSigningKey,
  removeSigningKey as registryRemoveSigningKey,
  addCorsOrigin as registryAddCorsOrigin,
  removeCorsOrigin as registryRemoveCorsOrigin,
  updatePrivacy as registryUpdatePrivacy,
  rotateStreamReaderKey,
  listProjects,
  listProjectStreams,
  getStreamEntry,
  getProjectEntry,
} from "../storage/registry";

// Created at module scope so the in-flight coalescing Map is shared across
// all requests in the isolate (WorkerEntrypoint creates a new instance per
// request, so an instance field would give each request its own empty Map).
const handler = createStreamWorker();

export default class ServerWorker extends WorkerEntrypoint<BaseEnv> {
  // HTTP traffic delegates to existing factory (external callers, unchanged)
  async fetch(request: Request): Promise<Response> {
    return handler.fetch!(request as unknown as Request<unknown, IncomingRequestCfProperties>, this.env, this.ctx);
  }

  // Queue handler for async fanout
  async queue(batch: MessageBatch): Promise<void> {
    return handler.queue!(batch, this.env, this.ctx);
  }

  // RPC: register a project's signing secret in REGISTRY KV
  // Called by admin workers
  async registerProject(projectId: string, signingSecret: string, options?: { corsOrigins?: string[] }): Promise<void> {
    await createProject(this.env.REGISTRY, projectId, signingSecret, options);
  }

  // RPC: add a signing key to a project (prepended as new primary)
  async addSigningKey(projectId: string, newSecret: string): Promise<{ keyCount: number }> {
    return registryAddSigningKey(this.env.REGISTRY, projectId, newSecret);
  }

  // RPC: remove a signing key from a project (refuses to remove the last key)
  async removeSigningKey(projectId: string, secretToRemove: string): Promise<{ keyCount: number }> {
    return registryRemoveSigningKey(this.env.REGISTRY, projectId, secretToRemove);
  }

  // RPC: list all projects
  async listProjects(): Promise<string[]> {
    return listProjects(this.env.REGISTRY);
  }

  // RPC: list all streams for a project
  async listProjectStreams(projectId: string): Promise<{ streamId: string; createdAt: number }[]> {
    return listProjectStreams(this.env.REGISTRY, projectId);
  }

  // RPC: get project config from REGISTRY (admin-only, no auth required via service binding)
  async getProjectConfig(projectId: string): Promise<{
    signingSecrets: string[];
    corsOrigins?: string[];
    isPublic?: boolean;
  } | null> {
    return getProjectEntry(this.env.REGISTRY, projectId);
  }

  // RPC: add CORS origin to a project
  async addCorsOrigin(projectId: string, origin: string): Promise<void> {
    return registryAddCorsOrigin(this.env.REGISTRY, projectId, origin);
  }

  // RPC: remove CORS origin from a project
  async removeCorsOrigin(projectId: string, origin: string): Promise<void> {
    return registryRemoveCorsOrigin(this.env.REGISTRY, projectId, origin);
  }

  // RPC: update project privacy setting
  async updatePrivacy(projectId: string, isPublic: boolean): Promise<void> {
    return registryUpdatePrivacy(this.env.REGISTRY, projectId, isPublic);
  }

  // RPC: get stream metadata from REGISTRY
  async getStreamMetadata(doKey: string): Promise<{
    public: boolean;
    content_type: string;
    created_at: number;
    readerKey?: string;
  } | null> {
    return getStreamEntry(this.env.REGISTRY, doKey);
  }

  // RPC: stream inspection (replaces /admin HTTP endpoint)
  async inspectStream(doKey: string): Promise<StreamIntrospection | null> {
    const stub = this.env.STREAMS.getByName(doKey);
    return stub.getIntrospection(doKey);
  }

  // RPC: route any stream request without auth (reads, writes, SSE)
  async routeRequest(doKey: string, request: Request): Promise<Response> {
    const stub = this.env.STREAMS.getByName(doKey);
    return stub.routeStreamRequest(doKey, false, request);
  }

  // RPC: rotate the reader key for a stream (invalidates all CDN-cached entries)
  async rotateReaderKey(doKey: string): Promise<{ readerKey: string }> {
    const readerKey = `rk_${crypto.randomUUID().replace(/-/g, "")}`;
    await rotateStreamReaderKey(this.env.REGISTRY, doKey, readerKey);
    return { readerKey };
  }
}

export { ServerWorker, StreamDO, SubscriptionDO, EstuaryDO, createStreamWorker };
export type { StreamIntrospection } from "./durable-object";
export type { BaseEnv } from "./index";
export type { ProjectEntry, StreamEntry } from "../storage/registry";

