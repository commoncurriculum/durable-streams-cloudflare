import type { Browser } from "@playwright/test";

const ADMIN_URL = process.env.ADMIN_URL!;

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
