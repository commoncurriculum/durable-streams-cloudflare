/**
 * Shared read-modify-write layer for ALL REGISTRY KV data.
 *
 * Every code path that touches REGISTRY — core RPC methods,
 * admin server functions, worker handlers — MUST go through
 * these functions to avoid field loss.
 *
 * KV Keys:
 * - `{projectId}` → ProjectEntry
 * - `{projectId}/{streamId}` → StreamEntry
 *
 * NOTE: This module defines types for data stored in REGISTRY KV only.
 * Do NOT confuse with:
 * - `StreamMeta` in storage/types.ts: Internal DurableObject SQLite state
 *   (stream_id, tail_offset, segment info, etc.)
 */

import { type } from "arktype";

// ============================================================================
// Schemas (ArkType validation)
// ============================================================================

const projectEntrySchema = type({
  signingSecrets: "string[] >= 1",
  "corsOrigins?": "string[]",
  "isPublic?": "boolean",
  // Legacy field for migration
  "signingSecret?": "string",
});

const streamEntrySchema = type({
  public: "boolean",
  content_type: "string",
  created_at: "number",
  "readerKey?": "string",
});

// ============================================================================
// Types
// ============================================================================

/** Full shape of a project entry in REGISTRY KV. */
export type ProjectEntry = {
  signingSecrets: string[];
  corsOrigins?: string[];
  isPublic?: boolean;
  /** Legacy single-secret field; normalized to signingSecrets on read. */
  signingSecret?: string;
};

/** Full shape of a stream metadata entry in REGISTRY KV. */
export type StreamEntry = {
  public: boolean;
  content_type: string;
  created_at: number;
  readerKey?: string;
};

// ============================================================================
// Project Entry Read / Write
// ============================================================================

/**
 * Read a project entry from KV by project ID.
 * Normalizes the legacy `signingSecret` → `signingSecrets` format.
 * Returns null if the key doesn't exist or isn't a valid object.
 */
export async function getProjectEntry(
  kv: KVNamespace,
  projectId: string,
): Promise<ProjectEntry | null> {
  const raw = await kv.get(projectId, "json");
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;

  // Normalize legacy single-secret format
  if (!Array.isArray(record.signingSecrets) && typeof record.signingSecret === "string") {
    record.signingSecrets = [record.signingSecret];
    delete record.signingSecret;
  }

  // Validate with schema
  const validated = projectEntrySchema(record);
  if (validated instanceof type.errors) {
    return null;
  }

  return validated as ProjectEntry;
}

/**
 * Write a project entry to KV.
 * Serializes the full entry — callers must pass the complete object.
 */
export async function putProjectEntry(
  kv: KVNamespace,
  projectId: string,
  entry: ProjectEntry,
): Promise<void> {
  await kv.put(projectId, JSON.stringify(entry));
}

// ============================================================================
// Stream Entry Read / Write
// ============================================================================

/**
 * Read a stream entry from KV by doKey (projectId/streamId).
 * Returns null if the key doesn't exist or isn't valid.
 */
export async function getStreamEntry(kv: KVNamespace, doKey: string): Promise<StreamEntry | null> {
  const raw = await kv.get(doKey, "json");
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;

  // Validate with schema
  const validated = streamEntrySchema(record);
  if (validated instanceof type.errors) {
    return null;
  }

  return validated as StreamEntry;
}

/**
 * Create or update stream metadata.
 * If the stream exists, preserves existing fields and merges new ones.
 */
export async function putStreamMetadata(
  kv: KVNamespace,
  doKey: string,
  metadata: {
    public: boolean;
    content_type: string;
    readerKey?: string;
  },
): Promise<void> {
  const existing = await getStreamEntry(kv, doKey);
  const entry: StreamEntry = {
    public: metadata.public,
    content_type: metadata.content_type,
    created_at: existing?.created_at ?? Date.now(),
  };
  // Preserve existing readerKey or set new one; omit entirely if undefined
  // (ArkType rejects explicit undefined for optional string fields)
  const readerKey = metadata.readerKey ?? existing?.readerKey;
  if (readerKey) entry.readerKey = readerKey;
  await kv.put(doKey, JSON.stringify(entry));
}

/**
 * Delete stream metadata from REGISTRY.
 * Used when a stream is deleted or expires.
 */
export async function deleteStreamEntry(kv: KVNamespace, doKey: string): Promise<void> {
  await kv.delete(doKey);
}
