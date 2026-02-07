import * as p from "@clack/prompts";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd: string, opts?: { input?: string }): string {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      stdio: opts?.input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      input: opts?.input,
    }).trim();
  } catch (e: unknown) {
    const msg = e instanceof Error ? (e as Error & { stderr?: string }).stderr ?? e.message : String(e);
    throw new Error(`Command failed: ${cmd}\n${msg}`);
  }
}

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
  p.cancel("Setup cancelled.");
  process.exit(0);
}

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function writeFile(path: string, content: string, overwriteAll: boolean): boolean {
  if (existsSync(path) && !overwriteAll) {
    return false; // caller should prompt
  }
  const dir = path.substring(0, path.lastIndexOf("/"));
  ensureDir(dir);
  writeFileSync(path, content, "utf-8");
  return true;
}

// ---------------------------------------------------------------------------
// File templates
// ---------------------------------------------------------------------------

function coreWorkerTs(): string {
  return `import { createStreamWorker, StreamDO, projectJwtAuth } from "@durable-streams-cloudflare/core";

const { authorizeMutation, authorizeRead } = projectJwtAuth();
export default createStreamWorker({ authorizeMutation, authorizeRead });
export { StreamDO };
`;
}

function coreWranglerToml(opts: { kvNamespaceId: string }): string {
  return `name = "durable-streams"
main = "src/worker.ts"
compatibility_date = "2025-02-02"

[durable_objects]
bindings = [{ name = "STREAMS", class_name = "StreamDO" }]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["StreamDO"]

[[r2_buckets]]
binding = "R2"
bucket_name = "durable-streams"

[[kv_namespaces]]
binding = "PROJECT_KEYS"
id = "${opts.kvNamespaceId}"

[[analytics_engine_datasets]]
binding = "METRICS"
dataset = "durable_streams_metrics"
`;
}

function subscriptionWorkerTs(): string {
  return `import { createSubscriptionWorker, SubscriptionDO, projectJwtAuth } from "@durable-streams-cloudflare/subscription";

export default createSubscriptionWorker({ authorize: projectJwtAuth() });
export { SubscriptionDO };
`;
}

function subscriptionWranglerToml(opts: {
  accountId: string;
  kvNamespaceId: string;
}): string {
  return `name = "durable-streams-subscriptions"
main = "src/worker.ts"
compatibility_date = "2025-02-02"

[vars]
ACCOUNT_ID = "${opts.accountId}"
SESSION_TTL_SECONDS = "1800"
ANALYTICS_DATASET = "subscriptions_metrics"

[durable_objects]
bindings = [{ name = "SUBSCRIPTION_DO", class_name = "SubscriptionDO" }]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["SubscriptionDO"]

[[kv_namespaces]]
binding = "PROJECT_KEYS"
id = "${opts.kvNamespaceId}"

[[analytics_engine_datasets]]
binding = "METRICS"
dataset = "subscriptions_metrics"

[[services]]
binding = "CORE"
service = "durable-streams"

[triggers]
crons = ["*/5 * * * *"]
`;
}

function adminCoreWranglerToml(opts: { kvNamespaceId: string }): string {
  return `name = "durable-streams-admin-core"
main = "node_modules/@durable-streams-cloudflare/admin-core/dist/server/index.js"
compatibility_date = "2026-02-02"
compatibility_flags = ["nodejs_compat"]
no_bundle = true

[assets]
directory = "node_modules/@durable-streams-cloudflare/admin-core/dist/client"

[[kv_namespaces]]
binding = "PROJECT_KEYS"
id = "${opts.kvNamespaceId}"

[[services]]
binding = "CORE"
service = "durable-streams"

[observability]
enabled = true
`;
}

function adminSubscriptionWranglerToml(opts: { kvNamespaceId: string }): string {
  return `name = "durable-streams-admin-subscription"
main = "node_modules/@durable-streams-cloudflare/admin-subscription/dist/server/index.js"
compatibility_date = "2026-02-02"
compatibility_flags = ["nodejs_compat"]
no_bundle = true

[assets]
directory = "node_modules/@durable-streams-cloudflare/admin-subscription/dist/client"

[[kv_namespaces]]
binding = "PROJECT_KEYS"
id = "${opts.kvNamespaceId}"

[[services]]
binding = "SUBSCRIPTION"
service = "durable-streams-subscriptions"

[[services]]
binding = "CORE"
service = "durable-streams"

[observability]
enabled = true
`;
}

// ---------------------------------------------------------------------------
// Secret helper
// ---------------------------------------------------------------------------

function putSecret(name: string, value: string, configPath: string) {
  // wrangler secret put reads from stdin
  const result = runMayFail(`npx -y wrangler secret put ${name} --config ${configPath}`, { input: value });
  if (!result.ok) {
    p.log.warning(`  Failed to set ${name}: ${result.stderr}`);
  }
}

// ---------------------------------------------------------------------------
// Deploy helper — parse URL from wrangler deploy output
// ---------------------------------------------------------------------------

function parseDeployedUrl(output: string): string | null {
  // wrangler outputs something like: Published durable-streams (0.5s)
  //   https://durable-streams.xxx.workers.dev
  const match = output.match(/https:\/\/[^\s]+\.workers\.dev/);
  return match ? match[0] : null;
}

// ---------------------------------------------------------------------------
// Main setup wizard
// ---------------------------------------------------------------------------

export async function setup() {
  p.intro("Durable Streams — Setup Wizard");

  // -----------------------------------------------------------------------
  // Step 1: Preflight
  // -----------------------------------------------------------------------
  const preflightSpinner = p.spinner();
  preflightSpinner.start("Checking prerequisites");

  // Verify wrangler
  const wranglerVersion = runMayFail("npx -y wrangler --version");
  if (!wranglerVersion.ok) {
    preflightSpinner.stop("wrangler not found");
    p.log.error(
      "wrangler is required but was not found.\n" +
      "Install it with: npm install -g wrangler\n" +
      "Or run: npx -y wrangler login"
    );
    process.exit(1);
  }
  preflightSpinner.message("wrangler found — checking auth");

  // Verify logged in + extract account ID
  const whoami = runMayFail("npx -y wrangler whoami");
  if (!whoami.ok) {
    preflightSpinner.stop("Not logged in to Cloudflare");
    p.log.error(
      "You must be logged in to Cloudflare.\n" +
      "Run: npx -y wrangler login"
    );
    process.exit(1);
  }

  // Extract account ID from whoami output
  // Output looks like: "│ Account Name | account-id │"
  const accountIdMatch = whoami.stdout.match(/\b([a-f0-9]{32})\b/);
  let accountId = accountIdMatch ? accountIdMatch[1] : "";

  if (!accountId) {
    preflightSpinner.stop("Logged in (account ID not auto-detected)");
  } else {
    preflightSpinner.stop(`Logged in — account ${accountId.slice(0, 8)}...`);
  }

  // -----------------------------------------------------------------------
  // Step 2: Configuration prompts
  // -----------------------------------------------------------------------

  // Which packages?
  const includeSubscription = await p.confirm({
    message: "Deploy the subscription (pub/sub) layer?",
    initialValue: true,
  });
  if (p.isCancel(includeSubscription)) cancelled();

  const includeAdminCore = await p.confirm({
    message: "Deploy the admin dashboard for core?",
    initialValue: true,
  });
  if (p.isCancel(includeAdminCore)) cancelled();

  let includeAdminSubscription = false;
  if (includeSubscription) {
    const result = await p.confirm({
      message: "Deploy the admin dashboard for subscription?",
      initialValue: true,
    });
    if (p.isCancel(result)) cancelled();
    includeAdminSubscription = result;
  }

  // Cloudflare API token (for subscription cron + admin dashboards)
  let cfApiToken = "";
  if (includeSubscription || includeAdminCore || includeAdminSubscription) {
    const input = await p.text({
      message: "Cloudflare API token (Analytics Engine read permission):",
      placeholder: "Needed for cron cleanup + admin dashboards",
      validate: (v) => v.length === 0 ? "API token is required" : undefined,
    });
    if (p.isCancel(input)) cancelled();
    cfApiToken = input;
  }

  // Account ID fallback prompt
  if (!accountId && (includeSubscription || includeAdminCore || includeAdminSubscription)) {
    const input = await p.text({
      message: "Cloudflare Account ID:",
      placeholder: "Couldn't auto-detect — find it in the CF dashboard",
      validate: (v) => v.length === 0 ? "Account ID is required" : undefined,
    });
    if (p.isCancel(input)) cancelled();
    accountId = input;
  }

  // -----------------------------------------------------------------------
  // Step 3: Create Cloudflare resources (needed before scaffolding)
  // -----------------------------------------------------------------------
  const resourceSpinner = p.spinner();
  resourceSpinner.start("Creating R2 bucket");

  const r2Result = runMayFail("npx -y wrangler r2 bucket create durable-streams");
  if (!r2Result.ok) {
    if (r2Result.stderr.includes("already exists")) {
      resourceSpinner.stop("R2 bucket already exists (OK)");
    } else {
      resourceSpinner.stop("R2 bucket creation failed");
      p.log.error(r2Result.stderr);
      process.exit(1);
    }
  } else {
    resourceSpinner.stop("R2 bucket created");
  }

  // Create KV namespace for PROJECT_KEYS
  const kvSpinner = p.spinner();
  kvSpinner.start("Creating KV namespace PROJECT_KEYS");

  let kvNamespaceId = "";
  const kvResult = runMayFail("npx -y wrangler kv namespace create PROJECT_KEYS");
  if (kvResult.ok) {
    const idMatch = kvResult.stdout.match(/id\s*=\s*"([a-f0-9]+)"/);
    if (idMatch) {
      kvNamespaceId = idMatch[1];
      kvSpinner.stop(`KV namespace created: ${kvNamespaceId.slice(0, 8)}...`);
    } else {
      kvSpinner.stop("KV namespace created (ID not auto-detected)");
    }
  } else {
    kvSpinner.stop("KV namespace creation failed (may already exist)");
  }

  if (!kvNamespaceId) {
    const input = await p.text({
      message: "PROJECT_KEYS KV namespace ID:",
      placeholder: "Paste from CF dashboard or `wrangler kv namespace list`",
      validate: (v) => v.length === 0 ? "Namespace ID is required" : undefined,
    });
    if (p.isCancel(input)) cancelled();
    kvNamespaceId = input;
  }

  // -----------------------------------------------------------------------
  // Step 4: Scaffold files
  // -----------------------------------------------------------------------
  p.log.step("Scaffolding worker files into workers/");

  const cwd = process.cwd();
  const workersDir = join(cwd, "workers");

  // Check for existing files
  const filesToWrite: Array<{ path: string; content: string }> = [];

  // Core (always)
  filesToWrite.push(
    { path: join(workersDir, "streams", "src", "worker.ts"), content: coreWorkerTs() },
    { path: join(workersDir, "streams", "wrangler.toml"), content: coreWranglerToml({ kvNamespaceId }) },
  );

  // Subscription
  if (includeSubscription) {
    filesToWrite.push(
      { path: join(workersDir, "subscriptions", "src", "worker.ts"), content: subscriptionWorkerTs() },
      {
        path: join(workersDir, "subscriptions", "wrangler.toml"),
        content: subscriptionWranglerToml({ accountId, kvNamespaceId }),
      },
    );
  }

  // Admin core — wrangler.toml only (pre-built package, no source files needed)
  if (includeAdminCore) {
    filesToWrite.push(
      { path: join(workersDir, "admin-core", "wrangler.toml"), content: adminCoreWranglerToml({ kvNamespaceId }) },
    );
  }

  // Admin subscription — wrangler.toml only (pre-built package, no source files needed)
  if (includeAdminSubscription) {
    filesToWrite.push(
      { path: join(workersDir, "admin-subscription", "wrangler.toml"), content: adminSubscriptionWranglerToml({ kvNamespaceId }) },
    );
  }

  // Check for existing files and ask about overwriting
  const existing = filesToWrite.filter((f) => existsSync(f.path));
  let overwriteAll = false;
  if (existing.length > 0) {
    const paths = existing.map((f) => f.path.replace(cwd + "/", "")).join("\n  ");
    const result = await p.confirm({
      message: `These files already exist:\n  ${paths}\n\nOverwrite them?`,
      initialValue: false,
    });
    if (p.isCancel(result)) cancelled();
    if (!result) {
      p.log.warning("Skipping file scaffolding — existing files preserved.");
    } else {
      overwriteAll = true;
    }
  }

  if (existing.length === 0 || overwriteAll) {
    for (const f of filesToWrite) {
      writeFile(f.path, f.content, true);
      p.log.info(`  ${f.path.replace(cwd + "/", "")}`);
    }
  }

  // -----------------------------------------------------------------------
  // Step 5: Install npm dependencies
  // -----------------------------------------------------------------------
  const installSpinner = p.spinner();
  installSpinner.start("Installing npm dependencies");

  const packages = ["@durable-streams-cloudflare/core"];
  if (includeSubscription) packages.push("@durable-streams-cloudflare/subscription");
  if (includeAdminCore) packages.push("@durable-streams-cloudflare/admin-core");
  if (includeAdminSubscription) packages.push("@durable-streams-cloudflare/admin-subscription");

  const installResult = runMayFail(`pnpm add ${packages.join(" ")}`);
  if (!installResult.ok) {
    installSpinner.stop("Install failed");
    p.log.error(`Failed to install packages:\n${installResult.stderr}`);
    process.exit(1);
  }
  installSpinner.stop("Dependencies installed");

  // -----------------------------------------------------------------------
  // Step 6: Set secrets & deploy
  // -----------------------------------------------------------------------
  const deployedUrls: Record<string, string> = {};

  // --- Core ---
  const coreSpinner = p.spinner();
  coreSpinner.start("Deploying core worker");

  const coreConfig = join(workersDir, "streams", "wrangler.toml");

  const coreDeploy = runMayFail(`npx -y wrangler deploy --config ${coreConfig}`);
  if (!coreDeploy.ok) {
    coreSpinner.stop("Core deploy failed");
    p.log.error(coreDeploy.stderr);
    process.exit(1);
  }

  const coreUrl = parseDeployedUrl(coreDeploy.stdout) ?? parseDeployedUrl(coreDeploy.stderr) ?? "";
  if (coreUrl) {
    deployedUrls.core = coreUrl;
    coreSpinner.stop(`Core deployed: ${coreUrl}`);
  } else {
    coreSpinner.stop("Core deployed (URL not detected — check Cloudflare dashboard)");
  }

  // --- Subscription ---
  if (includeSubscription) {
    const subSpinner = p.spinner();
    subSpinner.start("Deploying subscription worker");

    const subConfig = join(workersDir, "subscriptions", "wrangler.toml");

    if (cfApiToken) {
      putSecret("API_TOKEN", cfApiToken, subConfig);
    }

    const subDeploy = runMayFail(`npx -y wrangler deploy --config ${subConfig}`);
    if (!subDeploy.ok) {
      subSpinner.stop("Subscription deploy failed");
      p.log.error(subDeploy.stderr);
      process.exit(1);
    }

    const subUrl = parseDeployedUrl(subDeploy.stdout) ?? parseDeployedUrl(subDeploy.stderr) ?? "";
    if (subUrl) {
      deployedUrls.subscription = subUrl;
      subSpinner.stop(`Subscription deployed: ${subUrl}`);
    } else {
      subSpinner.stop("Subscription deployed (URL not detected)");
    }
  }

  // --- Admin core ---
  if (includeAdminCore) {
    const adminSpinner = p.spinner();
    adminSpinner.start("Deploying admin-core worker");

    const adminConfig = join(workersDir, "admin-core", "wrangler.toml");

    if (accountId) putSecret("CF_ACCOUNT_ID", accountId, adminConfig);
    if (cfApiToken) putSecret("CF_API_TOKEN", cfApiToken, adminConfig);

    const adminDeploy = runMayFail(`npx -y wrangler deploy --config ${adminConfig}`);
    if (!adminDeploy.ok) {
      adminSpinner.stop("Admin-core deploy failed");
      p.log.error(adminDeploy.stderr);
      process.exit(1);
    }

    const adminUrl = parseDeployedUrl(adminDeploy.stdout) ?? parseDeployedUrl(adminDeploy.stderr) ?? "";
    if (adminUrl) {
      deployedUrls.adminCore = adminUrl;
      adminSpinner.stop(`Admin-core deployed: ${adminUrl}`);
    } else {
      adminSpinner.stop("Admin-core deployed (URL not detected)");
    }
  }

  // --- Admin subscription ---
  if (includeAdminSubscription) {
    const adminSubSpinner = p.spinner();
    adminSubSpinner.start("Deploying admin-subscription worker");

    const adminSubConfig = join(workersDir, "admin-subscription", "wrangler.toml");

    if (accountId) putSecret("CF_ACCOUNT_ID", accountId, adminSubConfig);
    if (cfApiToken) putSecret("CF_API_TOKEN", cfApiToken, adminSubConfig);

    const adminSubDeploy = runMayFail(`npx -y wrangler deploy --config ${adminSubConfig}`);
    if (!adminSubDeploy.ok) {
      adminSubSpinner.stop("Admin-subscription deploy failed");
      p.log.error(adminSubDeploy.stderr);
      process.exit(1);
    }

    const adminSubUrl =
      parseDeployedUrl(adminSubDeploy.stdout) ?? parseDeployedUrl(adminSubDeploy.stderr) ?? "";
    if (adminSubUrl) {
      deployedUrls.adminSubscription = adminSubUrl;
      adminSubSpinner.stop(`Admin-subscription deployed: ${adminSubUrl}`);
    } else {
      adminSubSpinner.stop("Admin-subscription deployed (URL not detected)");
    }
  }

  // -----------------------------------------------------------------------
  // Step 7: Summary
  // -----------------------------------------------------------------------
  const lines: string[] = [];

  lines.push("Deployed Workers:");
  if (deployedUrls.core) lines.push(`  Core:               ${deployedUrls.core}`);
  if (deployedUrls.subscription) lines.push(`  Subscription:       ${deployedUrls.subscription}`);
  if (deployedUrls.adminCore) lines.push(`  Admin (core):       ${deployedUrls.adminCore}`);
  if (deployedUrls.adminSubscription) lines.push(`  Admin (sub):        ${deployedUrls.adminSubscription}`);
  if (Object.keys(deployedUrls).length === 0) {
    lines.push("  (check your Cloudflare dashboard for URLs)");
  }

  lines.push("");
  lines.push("Auth: per-project JWT (HMAC-SHA256). Create projects with:");
  lines.push("  npx -y durable-streams create-project");

  if (deployedUrls.adminCore || deployedUrls.adminSubscription) {
    lines.push("");
    lines.push("Admin dashboards have no built-in auth.");
    lines.push("Protect them with Cloudflare Zero Trust Access:");
    lines.push("https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-apps/");
    lines.push("");
    lines.push("Optional: set CF_ACCESS_TEAM_DOMAIN secret for defense-in-depth JWT validation.");
  }

  if (deployedUrls.core) {
    lines.push("");
    lines.push("Quick test:");
    lines.push(`  # 1. Create a project: npx -y durable-streams create-project`);
    lines.push(`  # 2. Mint a JWT with the signing secret`);
    lines.push(`  # 3. Create a stream:`);
    lines.push(`  curl -X PUT -H 'Authorization: Bearer <JWT>' -H 'Content-Type: application/json' ${deployedUrls.core}/v1/<project>/stream/test`);
  }

  lines.push("");
  lines.push("Next: connect this repo to Cloudflare's GitHub integration for automatic deploys.");

  p.note(lines.join("\n"), "Setup complete");
  p.outro("Happy streaming!");
}
