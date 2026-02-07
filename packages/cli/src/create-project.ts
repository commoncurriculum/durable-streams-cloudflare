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

function generateSigningSecret(): string {
  return randomBytes(32).toString("hex");
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

  // Step 2: Signing secret
  const secretChoice = await p.select({
    message: "Signing secret for JWT auth:",
    options: [
      { value: "generate", label: "Auto-generate (recommended)" },
      { value: "custom", label: "Enter my own secret" },
    ],
  });
  if (p.isCancel(secretChoice)) cancelled();

  let signingSecret: string;
  if (secretChoice === "generate") {
    signingSecret = generateSigningSecret();
  } else {
    const input = await p.text({
      message: "Enter signing secret:",
      validate: (v) => v.length < 16 ? "Secret must be at least 16 characters" : undefined,
    });
    if (p.isCancel(input)) cancelled();
    signingSecret = input;
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
  spinner.start("Creating project in KV");

  const value = JSON.stringify({ signingSecret });
  // Escape single quotes for safe shell interpolation: replace ' with '\''
  const escapedValue = value.replace(/'/g, "'\\''");
  const result = runMayFail(
    `npx wrangler kv key put --namespace-id="${namespaceId}" "${projectName}" '${escapedValue}'`,
  );

  if (!result.ok) {
    spinner.stop("Failed to write KV key");
    p.log.error(result.stderr);
    process.exit(1);
  }

  spinner.stop("Project created");

  const lines = [
    `Project:         ${projectName}`,
    `Signing Secret:  ${signingSecret}`,
    "",
    "Save this signing secret — it won't be shown again!",
    "",
    "Mint a JWT with these claims:",
    `  {`,
    `    "sub": "${projectName}",`,
    `    "scope": "write",`,
    `    "exp": <unix-timestamp>`,
    `  }`,
    "",
    "Sign with HMAC-SHA256 using the signing secret above.",
    "",
    "Usage:",
    `  # Create a stream (replace <JWT> with your signed token)`,
    `  curl -X PUT -H "Authorization: Bearer <JWT>" \\`,
    `    <CORE_URL>/v1/${projectName}/stream/my-stream`,
    "",
    `  # Subscribe (replace <JWT> with a read or write token)`,
    `  curl -X POST -H "Authorization: Bearer <JWT>" \\`,
    `    -H "Content-Type: application/json" \\`,
    `    -d '{"streamId":"chat","sessionId":"<uuid>"}' \\`,
    `    <SUB_URL>/v1/${projectName}/subscribe`,
  ];

  p.note(lines.join("\n"), "Project created");
  p.outro("Done!");
}
