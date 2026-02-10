import { WorkerEntrypoint } from "cloudflare:workers";
import { type } from "arktype";
import { createStreamWorker } from "./create_worker";
import { projectJwtAuth } from "./auth";
import type { ProjectConfig } from "./auth";
import { StreamDO } from "./durable_object";
import type { StreamIntrospection } from "./durable_object";
import type { BaseEnv } from "./create_worker";
import {
  createProject,
  addSigningKey as registryAddSigningKey,
  removeSigningKey as registryRemoveSigningKey,
  addCorsOrigin as registryAddCorsOrigin,
  removeCorsOrigin as registryRemoveCorsOrigin,
  updatePrivacy as registryUpdatePrivacy,
  rotateStreamReaderKey,
  putStreamMetadata,
  listProjects,
  listProjectStreams,
  getStreamEntry,
  getProjectEntry,
} from "../storage/registry";

const { authorizeMutation, authorizeRead } = projectJwtAuth();

// Created at module scope so the in-flight coalescing Map is shared across
// all requests in the isolate (WorkerEntrypoint creates a new instance per
// request, so an instance field would give each request its own empty Map).
const handler = createStreamWorker({
  authorizeMutation,
  authorizeRead,
});

const putStreamOptions = type({
  "expiresAt?": "number",
  "body?": "ArrayBuffer",
  "contentType?": "string",
});

const INTERNAL_BASE_URL = "https://internal/v1/stream";

export default class CoreWorker extends WorkerEntrypoint<BaseEnv> {
  // HTTP traffic delegates to existing factory (external callers, unchanged)
  async fetch(request: Request): Promise<Response> {
    return handler.fetch!(request as unknown as Request<unknown, IncomingRequestCfProperties>, this.env, this.ctx);
  }

  // RPC: register a project's signing secret in core's REGISTRY KV
  // Called by admin workers so core can verify JWTs for browser SSE connections
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

  // RPC: read from a stream (GET)
  async readStream(
    doKey: string,
    offset: string,
  ): Promise<{ ok: boolean; status: number; body: string; nextOffset: string | null; upToDate: boolean; contentType: string }> {
    const stub = this.env.STREAMS.getByName(doKey);
    const response = await stub.routeStreamRequest(
      doKey, false,
      new Request(`${INTERNAL_BASE_URL}?offset=${encodeURIComponent(offset)}`),
    );
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      body,
      nextOffset: response.headers.get("Stream-Next-Offset"),
      upToDate: response.headers.get("Stream-Up-To-Date") === "true",
      contentType: response.headers.get("Content-Type") ?? "",
    };
  }

  // RPC: check if a stream exists
  async headStream(doKey: string): Promise<{ ok: boolean; status: number; body: string | null; contentType: string | null }> {
    const stub = this.env.STREAMS.getByName(doKey);
    const response = await stub.routeStreamRequest(
      doKey, false,
      new Request(INTERNAL_BASE_URL, { method: "HEAD" }),
    );
    const body = response.ok ? null : await response.text();
    return { ok: response.ok, status: response.status, body, contentType: response.headers.get("Content-Type") };
  }

  // RPC: create or touch a stream
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
      doKey, false,
      new Request(INTERNAL_BASE_URL, {
        method: "PUT",
        headers,
        body: options.body,
      }),
    );
    // Write stream metadata to REGISTRY on creation (same as HTTP handler)
    if (response.status === 201 && this.env.REGISTRY) {
      this.ctx.waitUntil(
        putStreamMetadata(this.env.REGISTRY, doKey, {
          public: false,
          content_type: response.headers.get("Content-Type") || "application/octet-stream",
        }),
      );
    }
    const body = response.ok ? null : await response.text();
    return { ok: response.ok, status: response.status, body };
  }

  // RPC: rotate the reader key for a stream (invalidates all CDN-cached entries)
  async rotateReaderKey(doKey: string): Promise<{ readerKey: string }> {
    const readerKey = `rk_${crypto.randomUUID().replace(/-/g, "")}`;
    await rotateStreamReaderKey(this.env.REGISTRY, doKey, readerKey);
    return { readerKey };
  }

  // RPC: delete a stream
  async deleteStream(doKey: string): Promise<{ ok: boolean; status: number; body: string | null }> {
    const stub = this.env.STREAMS.getByName(doKey);
    const response = await stub.routeStreamRequest(
      doKey, false,
      new Request(INTERNAL_BASE_URL, { method: "DELETE" }),
    );
    const body = response.ok ? null : await response.text();
    return { ok: response.ok, status: response.status, body };
  }

  // RPC: append to a stream (POST)
  async postStream(
    doKey: string,
    payload: ArrayBuffer,
    contentType: string,
    producerHeaders?: { producerId: string; producerEpoch: string; producerSeq: string },
  ): Promise<{ ok: boolean; status: number; nextOffset: string | null; upToDate: string | null; streamClosed: string | null; body: string | null }> {
    const headers: Record<string, string> = { "Content-Type": contentType };
    if (producerHeaders) {
      headers["Producer-Id"] = producerHeaders.producerId;
      headers["Producer-Epoch"] = producerHeaders.producerEpoch;
      headers["Producer-Seq"] = producerHeaders.producerSeq;
    }
    const stub = this.env.STREAMS.getByName(doKey);
    const response = await stub.routeStreamRequest(
      doKey, false,
      new Request(INTERNAL_BASE_URL, { method: "POST", headers, body: payload }),
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

export { CoreWorker, StreamDO, createStreamWorker };
export { projectJwtAuth, extractBearerToken, checkProjectJwt } from "./auth";
export type { StreamIntrospection } from "./durable_object";
export type {
  AuthResult,
  JwtAuthResult,
  AuthorizeMutation,
  AuthorizeRead,
  ProjectJwtEnv,
  ProjectJwtClaims,
  ProjectConfig,
} from "./auth";
export type { BaseEnv, StreamWorkerConfig } from "./create_worker";
export type { ProjectEntry, StreamEntry } from "../storage/registry";
export { parseStreamPath } from "./stream-path";
