import * as p from "@clack/prompts";
import { spawnSync } from "node:child_process";
import { generateSecret, exportJWK } from "jose";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")).version;

function runMayFail(
  cmd: string,
  opts?: { input?: string },
): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(cmd, {
    encoding: "utf-8",
    stdio: opts?.input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    input: opts?.input,
    shell: true,
  });
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function cancelled(): never {
  p.cancel("Cancelled.");
  process.exit(0);
}

/** Try multiple ways to invoke wrangler and return the working command prefix. */
function detectWrangler(): string | null {
  for (const cmd of ["wrangler", "npx -y wrangler", "pnpx wrangler"]) {
    if (runMayFail(`${cmd} --version`).ok) return cmd;
  }
  return null;
}

export async function generateSigningSecret(): Promise<string> {
  const secret = await generateSecret("HS256", { extractable: true });
  const jwk = await exportJWK(secret);
  return JSON.stringify(jwk);
}

export async function createProject() {
  p.intro(`Durable Streams — Create Project v${VERSION}`);

  const wranglerCmd = detectWrangler();
  if (!wranglerCmd) {
    p.log.error(
      "wrangler is required but was not found.\n" + "Install it with: npm install -g wrangler",
    );
    process.exit(1);
  }

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
    signingSecret = await generateSigningSecret();
  } else {
    const input = await p.text({
      message: "Enter signing secret:",
      validate: (v) => (v.length < 16 ? "Secret must be at least 16 characters" : undefined),
    });
    if (p.isCancel(input)) cancelled();
    signingSecret = input;
  }

  // Step 3: KV namespace ID (try to auto-detect from scaffolded wrangler.toml)
  let detectedNamespaceId = "";
  const coreTomlPath = join(process.cwd(), "workers", "streams", "wrangler.toml");
  if (existsSync(coreTomlPath)) {
    try {
      const toml = readFileSync(coreTomlPath, "utf-8");
      const match = toml.match(/binding\s*=\s*"REGISTRY"\s*\n\s*id\s*=\s*"([a-f0-9]+)"/);
      if (match) detectedNamespaceId = match[1];
    } catch {
      // ignore read errors
    }
  }

  const namespaceId = await p.text({
    message: "REGISTRY KV namespace ID:",
    ...(detectedNamespaceId
      ? { defaultValue: detectedNamespaceId, placeholder: `Auto-detected: ${detectedNamespaceId}` }
      : { placeholder: "Find this in your wrangler.toml or CF dashboard" }),
    validate: (v) => (v.length === 0 ? "Namespace ID is required" : undefined),
  });
  if (p.isCancel(namespaceId)) cancelled();

  // Step 4: Write to KV
  const spinner = p.spinner();
  spinner.start("Creating project in KV");

  const value = JSON.stringify({ signingSecrets: [signingSecret] });
  // Escape single quotes for safe shell interpolation: replace ' with '\''
  const escapedValue = value.replace(/'/g, "'\\''");
  const result = runMayFail(
    `${wranglerCmd} kv key put --namespace-id="${namespaceId}" "${projectName}" '${escapedValue}'`,
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
    `    <CORE_URL>/v1/stream/${projectName}/my-stream`,
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
