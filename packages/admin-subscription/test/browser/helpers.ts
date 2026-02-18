import type { Browser } from "@playwright/test";


/**
 * Create a project via the admin API route.
 * Returns the signing secret for JWT auth.
 */
export async function createProject(
  _browser: Browser,
  adminUrl: string,
  projectId: string,
): Promise<string> {
  const res = await fetch(`${adminUrl}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create project (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { signingSecret: string };
  return data.signingSecret;
}

/**
 * Create a session via the admin API route.
 * Returns the session ID.
 */
export async function createSession(
  adminUrl: string,
  projectId: string,
  sessionId?: string,
): Promise<string> {
  const res = await fetch(`${adminUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, sessionId }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create session (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { sessionId: string };
  return data.sessionId;
}
