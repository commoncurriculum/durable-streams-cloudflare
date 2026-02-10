/**
 * Shared read-modify-write layer for project config in REGISTRY KV.
 *
 * Every code path that touches project config — core RPC methods,
 * admin-core server functions, create_worker stream metadata —
 * MUST go through these functions to avoid field loss.
 */

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
