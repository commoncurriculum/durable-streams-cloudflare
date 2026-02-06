import * as p from "@clack/prompts";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";

function runMayFail(cmd: string, opts?: { input?: string }): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execSync(cmd, {
      encoding: "utf-8",
      stdio: opts?.input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      input: opts?.input,
    }).trim();
    return { ok: true, stdout, stderr: "" };
  } catch (e: unknown) {
    const err = e as Error & { stdout?: string; stderr?: string };
    return { ok: false, stdout: err.stdout?.trim() ?? "", stderr: err.stderr?.trim() ?? "" };
  }
}

function cancelled(): never {
  p.cancel("Cancelled.");
  process.exit(0);
}

function generateApiKey(projectName: string): string {
  const suffix = randomBytes(16).toString("hex");
  return `sk_${projectName}_${suffix}`;
}

export async function createProject() {
  p.intro("Durable Streams — Create Project");

  // Step 1: Get project name
  const projectName = await p.text({
    message: "Project name (alphanumeric, hyphens, underscores):",
    placeholder: "my-app",
    validate: (v) => {
      if (v.length === 0) return "Project name is required";
      if (!/^[a-zA-Z0-9_-]+$/.test(v)) return "Only alphanumeric, hyphens, and underscores allowed";
      return undefined;
    },
  });
  if (p.isCancel(projectName)) cancelled();

  // Step 2: API key
  const keyChoice = await p.select({
    message: "API key for this project:",
    options: [
      { value: "generate", label: "Auto-generate (recommended)" },
      { value: "custom", label: "Enter my own key" },
    ],
  });
  if (p.isCancel(keyChoice)) cancelled();

  let apiKey: string;
  if (keyChoice === "generate") {
    apiKey = generateApiKey(projectName);
  } else {
    const input = await p.text({
      message: "Enter API key:",
      validate: (v) => v.length < 8 ? "Key must be at least 8 characters" : undefined,
    });
    if (p.isCancel(input)) cancelled();
    apiKey = input;
  }

  // Step 3: KV namespace ID
  const namespaceId = await p.text({
    message: "PROJECT_KEYS KV namespace ID:",
    placeholder: "Find this in your wrangler.toml or CF dashboard",
    validate: (v) => v.length === 0 ? "Namespace ID is required" : undefined,
  });
  if (p.isCancel(namespaceId)) cancelled();

  // Step 4: Write to KV
  const spinner = p.spinner();
  spinner.start("Creating project key in KV");

  const value = JSON.stringify({ project: projectName });
  const result = runMayFail(
    `npx wrangler kv key put --namespace-id="${namespaceId}" "${apiKey}" '${value}'`,
  );

  if (!result.ok) {
    spinner.stop("Failed to write KV key");
    p.log.error(result.stderr);
    process.exit(1);
  }

  spinner.stop("Project key created");

  const lines = [
    `Project:  ${projectName}`,
    `API Key:  ${apiKey}`,
    "",
    "Save this API key — it won't be shown again!",
    "",
    "Usage:",
    `  # Core: create a stream`,
    `  curl -X PUT -H "Authorization: Bearer ${apiKey}" \\`,
    `    <CORE_URL>/v1/${projectName}/stream/my-stream`,
    "",
    `  # Subscription: subscribe`,
    `  curl -X POST -H "Authorization: Bearer ${apiKey}" \\`,
    `    -H "Content-Type: application/json" \\`,
    `    -d '{"streamId":"chat","sessionId":"<uuid>"}' \\`,
    `    <SUB_URL>/v1/${projectName}/subscribe`,
  ];

  p.note(lines.join("\n"), "Project created");
  p.outro("Done!");
}
