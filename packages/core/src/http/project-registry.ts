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
// Read / Write
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

  return record as unknown as ProjectEntry;
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
// Mutations (read-modify-write)
// ============================================================================

/**
 * Create a new project with one signing secret.
 * If the project already exists, overwrites it (use for initial setup only).
 */
export async function createProject(
  kv: KVNamespace,
  projectId: string,
  signingSecret: string,
): Promise<void> {
  const existing = await getProjectEntry(kv, projectId);
  await putProjectEntry(kv, projectId, {
    ...existing,
    signingSecrets: [signingSecret],
  });
}

/**
 * Add a signing key (prepended as new primary).
 * Preserves all other fields.
 */
export async function addSigningKey(
  kv: KVNamespace,
  projectId: string,
  newSecret: string,
): Promise<{ keyCount: number }> {
  const entry = await getProjectEntry(kv, projectId);
  if (!entry) throw new Error(`Project "${projectId}" not found`);
  entry.signingSecrets = [newSecret, ...entry.signingSecrets];
  await putProjectEntry(kv, projectId, entry);
  return { keyCount: entry.signingSecrets.length };
}

/**
 * Remove a signing key. Refuses to remove the last one.
 * Preserves all other fields.
 */
export async function removeSigningKey(
  kv: KVNamespace,
  projectId: string,
  secretToRemove: string,
): Promise<{ keyCount: number }> {
  const entry = await getProjectEntry(kv, projectId);
  if (!entry) throw new Error(`Project "${projectId}" not found`);
  const filtered = entry.signingSecrets.filter((s) => s !== secretToRemove);
  if (filtered.length === 0) throw new Error("Cannot remove the last signing key");
  entry.signingSecrets = filtered;
  await putProjectEntry(kv, projectId, entry);
  return { keyCount: filtered.length };
}

/**
 * Add a CORS origin if not already present.
 * Preserves all other fields.
 */
export async function addCorsOrigin(
  kv: KVNamespace,
  projectId: string,
  origin: string,
): Promise<void> {
  const entry = await getProjectEntry(kv, projectId);
  if (!entry) throw new Error(`Project "${projectId}" not found`);
  const origins = entry.corsOrigins ?? [];
  if (!origins.includes(origin)) {
    origins.push(origin);
  }
  entry.corsOrigins = origins;
  await putProjectEntry(kv, projectId, entry);
}

/**
 * Remove a CORS origin.
 * Preserves all other fields.
 */
export async function removeCorsOrigin(
  kv: KVNamespace,
  projectId: string,
  origin: string,
): Promise<void> {
  const entry = await getProjectEntry(kv, projectId);
  if (!entry) throw new Error(`Project "${projectId}" not found`);
  entry.corsOrigins = (entry.corsOrigins ?? []).filter((o) => o !== origin);
  await putProjectEntry(kv, projectId, entry);
}

/**
 * Update project privacy setting.
 * Preserves all other fields.
 */
export async function updatePrivacy(
  kv: KVNamespace,
  projectId: string,
  isPublic: boolean,
): Promise<void> {
  const entry = await getProjectEntry(kv, projectId);
  if (!entry) throw new Error(`Project "${projectId}" not found`);
  entry.isPublic = isPublic;
  await putProjectEntry(kv, projectId, entry);
}

/**
 * List all project IDs (keys without "/" are projects).
 */
export async function listProjects(kv: KVNamespace): Promise<string[]> {
  const list = await kv.list();
  return list.keys
    .map((k) => k.name)
    .filter((name) => !name.includes("/"))
    .sort();
}

// ============================================================================
// Stream Entry Read / Write
// ============================================================================

/**
 * Read a stream entry from KV by doKey (projectId/streamId).
 * Returns null if the key doesn't exist or isn't valid.
 */
export async function getStreamEntry(
  kv: KVNamespace,
  doKey: string,
): Promise<StreamEntry | null> {
  const raw = await kv.get(doKey, "json");
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  
  // Validate with schema
  const validated = streamEntrySchema(record);
  if (validated instanceof streamEntrySchema.errors) {
    return null;
  }
  
  return validated as StreamEntry;
}

/**
 * Write a stream entry to KV.
 * Validates the entry before writing.
 */
export async function putStreamEntry(
  kv: KVNamespace,
  doKey: string,
  entry: StreamEntry,
): Promise<void> {
  // Validate before writing
  const validated = streamEntrySchema(entry);
  if (validated instanceof streamEntrySchema.errors) {
    throw new Error(`Invalid stream entry: ${validated.summary}`);
  }
  await kv.put(doKey, JSON.stringify(entry));
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
    readerKey: metadata.readerKey,
  };
  await putStreamEntry(kv, doKey, entry);
}

/**
 * Rotate the reader key for a stream.
 * Preserves all other fields.
 */
export async function rotateStreamReaderKey(
  kv: KVNamespace,
  doKey: string,
  newReaderKey: string,
): Promise<void> {
  const entry = await getStreamEntry(kv, doKey);
  if (!entry) throw new Error(`Stream "${doKey}" not found in REGISTRY`);
  entry.readerKey = newReaderKey;
  await putStreamEntry(kv, doKey, entry);
}
