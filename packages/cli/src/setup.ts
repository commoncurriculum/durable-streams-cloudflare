import * as p from "@clack/prompts";
import { execSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")).version;

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
  p.cancel("Setup cancelled.");
  process.exit(0);
}

/** Try multiple ways to invoke wrangler and return the working command prefix. */
function detectWrangler(): string | null {
  for (const cmd of ["wrangler", "npx -y wrangler", "pnpx wrangler"]) {
    if (runMayFail(`${cmd} --version`).ok) return cmd;
  }
  return null;
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
// Names — single source of truth, used in templates + CLI logic
// ---------------------------------------------------------------------------

const WORKER_CORE = "durable-streams";
const WORKER_SUBSCRIPTION = "durable-streams-subscriptions";
const WORKER_ADMIN_CORE = "durable-streams-admin-core";
const WORKER_ADMIN_SUBSCRIPTION = "durable-streams-admin-subscription";
const R2_BUCKET = "durable-streams";
const KV_BINDING = "REGISTRY";
const GITHUB_REPO = "commoncurriculum/durable-streams-cloudflare";

// ---------------------------------------------------------------------------
// File templates
// ---------------------------------------------------------------------------

function coreWorkerTs(): string {
  return `export { default, StreamDO } from "@durable-streams-cloudflare/core";\n`;
}

function coreWranglerToml(opts: { kvNamespaceId: string }): string {
  return `name = "${WORKER_CORE}"
main = "src/worker.ts"
compatibility_date = "2026-02-02"

[durable_objects]
bindings = [{ name = "STREAMS", class_name = "StreamDO" }]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["StreamDO"]

[[r2_buckets]]
binding = "R2"
bucket_name = "${R2_BUCKET}"

[[kv_namespaces]]
binding = "${KV_BINDING}"
id = "${opts.kvNamespaceId}"

[[analytics_engine_datasets]]
binding = "METRICS"
dataset = "durable_streams_metrics"

[observability]
enabled = true
`;
}

function subscriptionWorkerTs(): string {
  return `export { default, SubscriptionDO, SessionDO } from "@durable-streams-cloudflare/subscription";\n`;
}

function subscriptionWranglerToml(opts: {
  kvNamespaceId: string;
}): string {
  return `name = "${WORKER_SUBSCRIPTION}"
main = "src/worker.ts"
compatibility_date = "2025-02-02"

[vars]
SESSION_TTL_SECONDS = "86400"

[durable_objects]
bindings = [
  { name = "SUBSCRIPTION_DO", class_name = "SubscriptionDO" },
  { name = "SESSION_DO", class_name = "SessionDO" },
]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["SubscriptionDO"]

[[migrations]]
tag = "v2"
new_sqlite_classes = ["SessionDO"]

[[kv_namespaces]]
binding = "${KV_BINDING}"
id = "${opts.kvNamespaceId}"

[[analytics_engine_datasets]]
binding = "METRICS"
dataset = "subscriptions_metrics"

[[services]]
binding = "CORE"
service = "${WORKER_CORE}"

# Queue-based fanout for hot topics.
# Without this binding, fanout is always inline.
[[queues.producers]]
binding = "FANOUT_QUEUE"
queue = "subscription-fanout"

# Uncomment to enable queue consumer (processes async fanout messages):
# [[queues.consumers]]
# queue = "subscription-fanout"
# max_batch_size = 10
# max_batch_timeout = 1
# max_retries = 3
# dead_letter_queue = "subscription-fanout-dlq"
`;
}

function adminCoreWranglerToml(opts: { kvNamespaceId: string }): string {
  return `name = "${WORKER_ADMIN_CORE}"
main = "upstream/packages/admin-core/dist/server/index.js"
compatibility_date = "2026-02-02"
compatibility_flags = ["nodejs_compat"]
no_bundle = true

[build]
command = "git clone --depth 1 https://github.com/${GITHUB_REPO}.git upstream && cd upstream && pnpm install && pnpm --filter admin-core run build"

[[rules]]
type = "ESModule"
globs = ["**/*.js"]

[assets]
directory = "upstream/packages/admin-core/dist/client"

[[kv_namespaces]]
binding = "${KV_BINDING}"
id = "${opts.kvNamespaceId}"

[[services]]
binding = "CORE"
service = "${WORKER_CORE}"

[observability]
enabled = true
`;
}

function adminSubscriptionWranglerToml(opts: { kvNamespaceId: string }): string {
  return `name = "${WORKER_ADMIN_SUBSCRIPTION}"
main = "upstream/packages/admin-subscription/dist/server/index.js"
compatibility_date = "2026-02-02"
compatibility_flags = ["nodejs_compat"]
no_bundle = true

[build]
command = "git clone --depth 1 https://github.com/${GITHUB_REPO}.git upstream && cd upstream && pnpm install && pnpm --filter admin-subscription run build"

[[rules]]
type = "ESModule"
globs = ["**/*.js"]

[assets]
directory = "upstream/packages/admin-subscription/dist/client"

[[kv_namespaces]]
binding = "${KV_BINDING}"
id = "${opts.kvNamespaceId}"

[[services]]
binding = "SUBSCRIPTION"
service = "${WORKER_SUBSCRIPTION}"

[[services]]
binding = "CORE"
service = "${WORKER_CORE}"

[observability]
enabled = true
`;
}

// ---------------------------------------------------------------------------
// Workspace templates
// ---------------------------------------------------------------------------

function rootPackageJson(opts: { components: string[] }): string {
  const scripts: Record<string, string> = {
    build: "pnpm -r --if-present run build",
    deploy: "pnpm -r run deploy",
  };
  if (opts.components.includes("core")) scripts["deploy:streams"] = "pnpm --filter streams run deploy";
  if (opts.components.includes("subscription")) scripts["deploy:subscriptions"] = "pnpm --filter subscriptions run deploy";
  if (opts.components.includes("admin-core")) scripts["deploy:admin-core"] = "pnpm --filter admin-core run deploy";
  if (opts.components.includes("admin-subscription")) scripts["deploy:admin-subscription"] = "pnpm --filter admin-subscription run deploy";

  const deps: Record<string, string> = {};
  if (opts.components.includes("core")) deps["@durable-streams-cloudflare/core"] = `github:${GITHUB_REPO}#path:packages/core`;
  if (opts.components.includes("subscription")) deps["@durable-streams-cloudflare/subscription"] = `github:${GITHUB_REPO}#path:packages/subscription`;

  const pkg: Record<string, unknown> = {
    private: true,
    packageManager: "pnpm@10.16.1",
    scripts,
    devDependencies: {
      wrangler: "^4.63.0",
    },
    ...(Object.keys(deps).length > 0 ? { dependencies: deps } : {}),
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

function pnpmWorkspaceYaml(): string {
  return `packages:
  - "workers/*"

onlyBuiltDependencies:
  - esbuild
  - workerd
  - sharp
`;
}

function workerPackageJson(opts: {
  name: string;
  dependency: string;
}): string {
  const pkgName = opts.dependency.split("/").pop()!;
  const pkg: Record<string, unknown> = {
    private: true,
    name: opts.name,
    scripts: {
      build: "true",
      deploy: "wrangler deploy",
    },
    dependencies: {
      [opts.dependency]: `github:${GITHUB_REPO}#path:packages/${pkgName}`,
    },
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

function adminPackageJson(opts: { name: string }): string {
  const pkg: Record<string, unknown> = {
    private: true,
    name: opts.name,
    scripts: {
      build: "true",
      deploy: "wrangler deploy",
    },
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Secret helper
// ---------------------------------------------------------------------------

function putSecret(name: string, value: string, configPath: string, wrangler: string) {
  // wrangler secret put reads from stdin
  const result = runMayFail(`${wrangler} secret put ${name} --config ${configPath}`, { input: value });
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
  p.intro(`Durable Streams — Setup Wizard v${VERSION}`);

  // -----------------------------------------------------------------------
  // Step 1: Preflight
  // -----------------------------------------------------------------------
  const preflightSpinner = p.spinner();
  preflightSpinner.start("Checking prerequisites");

  // Verify wrangler — try direct, npx, and pnpx
  const wranglerCmd = detectWrangler();
  if (!wranglerCmd) {
    preflightSpinner.stop("wrangler not found");
    p.log.error(
      "wrangler is required but was not found.\n" +
      "Install it with: npm install -g wrangler\n" +
      "Then run this setup again."
    );
    process.exit(1);
  }
  preflightSpinner.message("wrangler found — checking auth");

  // Verify logged in + extract account ID
  const whoami = runMayFail(`${wranglerCmd} whoami`);
  if (!whoami.ok) {
    preflightSpinner.stop("Not logged in to Cloudflare");
    p.log.error(
      "You must be logged in to Cloudflare.\n" +
      `Run: ${wranglerCmd} login`
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

  // Project directory
  const dirChoice = await p.select({
    message: "Where should we set up?",
    options: [
      { value: "cwd", label: `Current directory (${process.cwd()})` },
      { value: "new", label: "Create a new directory" },
    ],
  });
  if (p.isCancel(dirChoice)) cancelled();

  let projectDir = process.cwd();
  if (dirChoice === "new") {
    const dirName = await p.text({
      message: "Directory name:",
      placeholder: "my-streams-project",
      validate: (v) => v.length === 0 ? "Directory name is required" : undefined,
    });
    if (p.isCancel(dirName)) cancelled();
    projectDir = join(process.cwd(), dirName);
  }

  // Which packages?
  const components = await p.multiselect({
    message: "Which components do you want to deploy? (space to toggle, enter to confirm)",
    options: [
      { value: "core", label: "Core streams worker", hint: "required if not already deployed" },
      { value: "subscription", label: "Subscription (pub/sub) layer" },
      { value: "admin-core", label: "Admin dashboard for core" },
      { value: "admin-subscription", label: "Admin dashboard for subscription" },
    ],
    initialValues: ["core", "subscription", "admin-core", "admin-subscription"],
    required: true,
  });
  if (p.isCancel(components)) cancelled();

  const includeCore = components.includes("core");
  const includeSubscription = components.includes("subscription");
  const includeAdminCore = components.includes("admin-core");
  const includeAdminSubscription = components.includes("admin-subscription");

  // Cloudflare API token (for admin dashboards)
  let cfApiToken = "";
  if (includeAdminCore || includeAdminSubscription) {
    p.log.info(
      "An API token is needed for Analytics Engine access.\n" +
      "  1. Go to https://dash.cloudflare.com/profile/api-tokens\n" +
      "  2. Click \"Create Token\"\n" +
      '  3. Use the "Read analytics and logs" template\n' +
      "  4. Click \"Continue to summary\" > \"Create Token\"\n" +
      "  5. Copy the token"
    );
    const input = await p.text({
      message: "Paste your API token:",
      validate: (v) => v.length === 0 ? "API token is required" : undefined,
    });
    if (p.isCancel(input)) cancelled();
    cfApiToken = input;
  }

  // Account ID fallback prompt
  if (!accountId && (includeAdminCore || includeAdminSubscription)) {
    const input = await p.text({
      message: "Cloudflare Account ID:",
      placeholder: "Couldn't auto-detect — find it in the CF dashboard",
      validate: (v) => v.length === 0 ? "Account ID is required" : undefined,
    });
    if (p.isCancel(input)) cancelled();
    accountId = input;
  }

  // Confirm before proceeding
  const workerNames: string[] = [];
  if (includeCore) workerNames.push(`  ${WORKER_CORE.padEnd(38)} (core)`);
  if (includeSubscription) workerNames.push(`  ${WORKER_SUBSCRIPTION.padEnd(38)} (subscription)`);
  if (includeAdminCore) workerNames.push(`  ${WORKER_ADMIN_CORE.padEnd(38)} (admin)`);
  if (includeAdminSubscription) workerNames.push(`  ${WORKER_ADMIN_SUBSCRIPTION.padEnd(38)} (admin)`);

  p.note(
    `Directory: ${projectDir}\n\n` +
    "Workers to deploy:\n" +
    workerNames.join("\n") + "\n\n" +
    "This will:\n" +
    "  - Create an R2 bucket and KV namespace on Cloudflare\n" +
    "  - Set up a pnpm workspace with workers/ packages\n" +
    "  - Install dependencies\n" +
    "  - Deploy all workers above",
    "Ready to go"
  );
  const confirmed = await p.confirm({
    message: "Proceed?",
    initialValue: true,
  });
  if (p.isCancel(confirmed) || !confirmed) cancelled();

  // -----------------------------------------------------------------------
  // Step 3: Create Cloudflare resources (needed before scaffolding)
  // -----------------------------------------------------------------------
  const resourceSpinner = p.spinner();
  resourceSpinner.start(`Creating R2 bucket '${R2_BUCKET}'`);

  const r2Result = runMayFail(`${wranglerCmd} r2 bucket create ${R2_BUCKET}`);
  if (!r2Result.ok) {
    if (r2Result.stderr.includes("already exists")) {
      resourceSpinner.stop(`R2 bucket '${R2_BUCKET}' already exists (OK)`);
    } else {
      resourceSpinner.stop("R2 bucket creation failed");
      p.log.error(r2Result.stderr);
      process.exit(1);
    }
  } else {
    resourceSpinner.stop(`R2 bucket '${R2_BUCKET}' created`);
  }

  // Create KV namespace for REGISTRY
  const kvSpinner = p.spinner();
  kvSpinner.start(`Creating KV namespace ${KV_BINDING}`);

  let kvNamespaceId = "";
  const kvResult = runMayFail(`${wranglerCmd} kv namespace create ${KV_BINDING}`);
  // Wrangler outputs the namespace ID to stderr, so check both streams
  const kvOutput = kvResult.stdout + "\n" + kvResult.stderr;
  const idMatch = kvOutput.match(/id\s*=\s*"([a-f0-9]+)"/);
  if (idMatch) {
    kvNamespaceId = idMatch[1];
    kvSpinner.stop(`KV namespace created: ${kvNamespaceId.slice(0, 8)}...`);
  } else if (kvResult.ok) {
    kvSpinner.stop("KV namespace created (ID not auto-detected)");
  } else {
    // Namespace may already exist — try listing to find its ID
    kvSpinner.stop("KV namespace may already exist, looking it up...");
    const listResult = runMayFail(`${wranglerCmd} kv namespace list`);
    if (listResult.ok) {
      try {
        const namespaces = JSON.parse(listResult.stdout) as Array<{ id: string; title: string }>;
        const existing = namespaces.find((ns) => ns.title.includes(KV_BINDING));
        if (existing) {
          kvNamespaceId = existing.id;
          p.log.success(`Found existing KV namespace: ${kvNamespaceId.slice(0, 8)}...`);
        }
      } catch {
        // JSON parse failed, fall through to manual prompt
      }
    }
  }

  if (!kvNamespaceId) {
    const input = await p.text({
      message: `${KV_BINDING} KV namespace ID:`,
      placeholder: "Paste from CF dashboard or `wrangler kv namespace list`",
      validate: (v) => v.length === 0 ? "Namespace ID is required" : undefined,
    });
    if (p.isCancel(input)) cancelled();
    kvNamespaceId = input;
  }

  // -----------------------------------------------------------------------
  // Step 4: Scaffold files
  // -----------------------------------------------------------------------
  p.log.step("Setting up pnpm workspace");

  // Create project directory if needed
  if (dirChoice === "new") {
    ensureDir(projectDir);
  }

  const workersDir = join(projectDir, "workers");

  // Check for existing files
  const filesToWrite: Array<{ path: string; content: string }> = [];

  // Root workspace files
  filesToWrite.push(
    { path: join(projectDir, "package.json"), content: rootPackageJson({ components }) },
    { path: join(projectDir, "pnpm-workspace.yaml"), content: pnpmWorkspaceYaml() },
    { path: join(projectDir, ".npmrc"), content: "shamefully-hoist=true\n" },
  );

  // Core
  if (includeCore) {
    filesToWrite.push(
      { path: join(workersDir, "streams", "package.json"), content: workerPackageJson({ name: "streams", dependency: "@durable-streams-cloudflare/core" }) },
      { path: join(workersDir, "streams", "src", "worker.ts"), content: coreWorkerTs() },
      { path: join(workersDir, "streams", "wrangler.toml"), content: coreWranglerToml({ kvNamespaceId }) },
    );
  }

  // Subscription
  if (includeSubscription) {
    filesToWrite.push(
      { path: join(workersDir, "subscriptions", "package.json"), content: workerPackageJson({ name: "subscriptions", dependency: "@durable-streams-cloudflare/subscription" }) },
      { path: join(workersDir, "subscriptions", "src", "worker.ts"), content: subscriptionWorkerTs() },
      {
        path: join(workersDir, "subscriptions", "wrangler.toml"),
        content: subscriptionWranglerToml({ kvNamespaceId }),
      },
    );
  }

  // Admin core — wrangler.toml + package.json (built from upstream during deploy)
  if (includeAdminCore) {
    filesToWrite.push(
      { path: join(workersDir, "admin-core", "package.json"), content: adminPackageJson({ name: "admin-core" }) },
      { path: join(workersDir, "admin-core", "wrangler.toml"), content: adminCoreWranglerToml({ kvNamespaceId }) },
    );
  }

  // Admin subscription — wrangler.toml + package.json (built from upstream during deploy)
  if (includeAdminSubscription) {
    filesToWrite.push(
      { path: join(workersDir, "admin-subscription", "package.json"), content: adminPackageJson({ name: "admin-subscription" }) },
      { path: join(workersDir, "admin-subscription", "wrangler.toml"), content: adminSubscriptionWranglerToml({ kvNamespaceId }) },
    );
  }

  // Check for existing files and ask about overwriting
  const existing = filesToWrite.filter((f) => existsSync(f.path));
  let overwriteAll = false;
  if (existing.length > 0) {
    const paths = existing.map((f) => f.path.replace(projectDir + "/", "")).join("\n  ");
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
      p.log.info(`  ${f.path.replace(projectDir + "/", "")}`);
    }
  }

  // -----------------------------------------------------------------------
  // Step 5: Install dependencies (single pnpm install for the workspace)
  // -----------------------------------------------------------------------
  const installSpinner = p.spinner();
  installSpinner.start("Installing dependencies");

  const installResult = runMayFail(`cd "${projectDir}" && pnpm install`);
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
  if (includeCore) {
    const coreSpinner = p.spinner();
    coreSpinner.start("Deploying core worker");

    const coreConfig = join(workersDir, "streams", "wrangler.toml");

    const coreDeploy = runMayFail(`${wranglerCmd} deploy --config ${coreConfig}`);
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
  }

  // --- Subscription ---
  if (includeSubscription) {
    const subSpinner = p.spinner();
    subSpinner.start("Deploying subscription worker");

    const subConfig = join(workersDir, "subscriptions", "wrangler.toml");

    const subDeploy = runMayFail(`${wranglerCmd} deploy --config ${subConfig}`);
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

    if (accountId) putSecret("CF_ACCOUNT_ID", accountId, adminConfig, wranglerCmd);
    if (cfApiToken) putSecret("CF_API_TOKEN", cfApiToken, adminConfig, wranglerCmd);

    const adminDeploy = runMayFail(`${wranglerCmd} deploy --config ${adminConfig}`);
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

    if (accountId) putSecret("CF_ACCOUNT_ID", accountId, adminSubConfig, wranglerCmd);
    if (cfApiToken) putSecret("CF_API_TOKEN", cfApiToken, adminSubConfig, wranglerCmd);
    if (deployedUrls.core) putSecret("CORE_URL", deployedUrls.core, adminSubConfig, wranglerCmd);

    const adminSubDeploy = runMayFail(`${wranglerCmd} deploy --config ${adminSubConfig}`);
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
  // Step 7: Create first project
  // -----------------------------------------------------------------------
  let projectName = "";
  let signingSecret = "";

  if (includeCore) {
    const createNow = await p.confirm({
      message: "Create your first project now? (generates a JWT signing key)",
      initialValue: true,
    });
    if (p.isCancel(createNow)) cancelled();

    if (createNow) {
      const name = await p.text({
        message: "Project name (alphanumeric, hyphens, underscores):",
        placeholder: "my-app",
        validate: (v) => {
          if (v.length === 0) return "Project name is required";
          if (!/^[a-zA-Z0-9_-]+$/.test(v)) return "Only alphanumeric, hyphens, and underscores allowed";
          return undefined;
        },
      });
      if (p.isCancel(name)) cancelled();
      projectName = name;

      signingSecret = randomBytes(32).toString("hex");

      const kvSpinner2 = p.spinner();
      kvSpinner2.start("Creating project in KV");

      const value = JSON.stringify({ signingSecrets: [signingSecret] });
      const escapedValue = value.replace(/'/g, "'\\''");
      const kvWriteResult = runMayFail(
        `${wranglerCmd} kv key put --namespace-id="${kvNamespaceId}" "${projectName}" '${escapedValue}'`,
      );

      if (!kvWriteResult.ok) {
        kvSpinner2.stop("Failed to write project key");
        p.log.error(kvWriteResult.stderr);
      } else {
        kvSpinner2.stop("Project created");
        p.note(
          `Project:        ${projectName}\n` +
          `Signing Secret: ${signingSecret}\n\n` +
          "Save this signing secret — it won't be shown again!\n\n" +
          "Mint a JWT with these claims:\n" +
          `  { "sub": "${projectName}", "scope": "write", "exp": <unix-timestamp> }\n\n` +
          "Sign with HMAC-SHA256 using the signing secret above.",
          `Project: ${projectName}`
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // Step 8: Zero Trust walkthrough (if admin dashboards deployed)
  // -----------------------------------------------------------------------
  if (deployedUrls.adminCore || deployedUrls.adminSubscription) {
    const adminDomains: string[] = [];
    if (deployedUrls.adminCore) {
      adminDomains.push(deployedUrls.adminCore.replace("https://", ""));
    }
    if (deployedUrls.adminSubscription) {
      adminDomains.push(deployedUrls.adminSubscription.replace("https://", ""));
    }

    p.note(
      "Your admin dashboards have no built-in auth.\n" +
      "Set up Cloudflare Zero Trust to protect them:\n\n" +
      "  1. Go to https://one.dash.cloudflare.com\n" +
      "  2. Access > Applications > Add an application\n" +
      "  3. Choose \"Self-hosted\"\n" +
      "  4. Application domain: " + adminDomains[0] + "\n" +
      "  5. Add a policy (e.g., allow your email domain)\n" +
      (adminDomains.length > 1
        ? `  6. Repeat for: ${adminDomains[1]}\n`
        : "") +
      "\n" +
      "Docs: https://developers.cloudflare.com/cloudflare-one/\n" +
      "      applications/configure-apps/self-hosted-apps/",
      "Protect admin dashboards"
    );

    const ztDone = await p.confirm({
      message: "Continue (you can set this up later)",
      initialValue: true,
    });
    if (p.isCancel(ztDone)) cancelled();
  }

  // -----------------------------------------------------------------------
  // Step 9: Git + GitHub
  // -----------------------------------------------------------------------
  const setupGit = await p.confirm({
    message: "Set up Git and push to GitHub?",
    initialValue: true,
  });
  if (p.isCancel(setupGit)) cancelled();

  let repoUrl = "";

  if (setupGit) {
    // Initialize git if needed
    const isGitRepo = runMayFail(`git -C ${projectDir} rev-parse --git-dir`);
    if (!isGitRepo.ok) {
      const gitInitSpinner = p.spinner();
      gitInitSpinner.start("Initializing git repo");
      runMayFail(`git -C ${projectDir} init`);
      gitInitSpinner.stop("Git repo initialized");
    }

    // Create .gitignore
    const gitignorePath = join(projectDir, ".gitignore");
    if (!existsSync(gitignorePath)) {
      writeFile(gitignorePath, "node_modules/\ndist/\n.wrangler/\n.npmrc\nworkers/admin-*/src\n.DS_Store\n.claude/settings.local.json\n", true);
      p.log.info("  Created .gitignore");
    }

    // Initial commit
    runMayFail(`git -C ${projectDir} add -A`);
    const needsCommit = runMayFail(`git -C ${projectDir} diff --cached --quiet`);
    if (!needsCommit.ok) {
      runMayFail(`git -C ${projectDir} commit -m "Initial setup via durable-streams CLI"`);
      p.log.info("  Created initial commit");
    }

    // Check for gh CLI
    const hasGh = runMayFail("gh --version");
    if (hasGh.ok) {
      const createRepo = await p.confirm({
        message: "Create a GitHub repo? (requires gh CLI)",
        initialValue: true,
      });
      if (p.isCancel(createRepo)) cancelled();

      if (createRepo) {
        // List GitHub orgs so user can pick where to create the repo
        const orgsResult = runMayFail("gh api user/orgs --jq '.[].login'");
        const orgs = orgsResult.ok ? orgsResult.stdout.split("\n").filter(Boolean) : [];

        let repoOwner = "";
        if (orgs.length > 0) {
          const ownerChoice = await p.select({
            message: "Create repo under:",
            options: [
              ...orgs.map((org) => ({ value: org, label: org })),
              { value: "_personal", label: "Personal account" },
            ],
          });
          if (p.isCancel(ownerChoice)) cancelled();
          repoOwner = ownerChoice === "_personal" ? "" : ownerChoice;
        }

        const defaultName = projectDir.split("/").pop() ?? WORKER_CORE;
        const repoName = await p.text({
          message: "GitHub repo name:",
          placeholder: defaultName,
          defaultValue: defaultName,
          validate: (v) => v.length === 0 ? "Repo name is required" : undefined,
        });
        if (p.isCancel(repoName)) cancelled();

        const visibility = await p.select({
          message: "Repo visibility:",
          options: [
            { value: "private", label: "Private" },
            { value: "public", label: "Public" },
          ],
        });
        if (p.isCancel(visibility)) cancelled();

        const fullRepoName = repoOwner ? `${repoOwner}/${repoName}` : repoName;

        const repoSpinner = p.spinner();
        repoSpinner.start(`Creating ${visibility} repo: ${fullRepoName}`);

        const ghResult = runMayFail(
          `cd "${projectDir}" && gh repo create "${fullRepoName}" --${visibility} --source=. --push`,
        );

        if (ghResult.ok) {
          // gh outputs the URL to stderr
          const combined = ghResult.stdout + "\n" + ghResult.stderr;
          const urlMatch = combined.match(/https:\/\/github\.com\/[^\s]+/);
          repoUrl = urlMatch ? urlMatch[0] : "";
          repoSpinner.stop(repoUrl ? `Repo created: ${repoUrl}` : "Repo created and pushed");
        } else {
          repoSpinner.stop("Repo creation failed");
          p.log.warning(ghResult.stderr || ghResult.stdout);
          p.log.info("You can create the repo manually and push later.");
        }
      }
    } else {
      p.log.info(
        "Install the GitHub CLI (gh) to create a repo from here,\n" +
        "or push manually: git remote add origin <url> && git push -u origin main"
      );
    }
  }

  // -----------------------------------------------------------------------
  // Step 10: Connect to GitHub for auto-deploys
  // -----------------------------------------------------------------------
  if (setupGit) {
    const deployedWorkerNames: string[] = [];
    if (includeCore) deployedWorkerNames.push(WORKER_CORE);
    if (includeSubscription) deployedWorkerNames.push(WORKER_SUBSCRIPTION);
    if (includeAdminCore) deployedWorkerNames.push(WORKER_ADMIN_CORE);
    if (includeAdminSubscription) deployedWorkerNames.push(WORKER_ADMIN_SUBSCRIPTION);

    p.note(
      "Connect your repo to Cloudflare for automatic deploys on push:\n\n" +
      deployedWorkerNames.map((name, i) =>
        `  ${i === 0 ? "For" : "Repeat for"} "${name}":\n` +
        "    1. Go to https://dash.cloudflare.com > Workers & Pages\n" +
        `    2. Select "${name}"\n` +
        "    3. Settings > Builds > Connect to Git\n" +
        "    4. Select your repo and configure"
      ).join("\n\n"),
      "Automatic deploys"
    );

    const cfDone = await p.confirm({
      message: "Continue (you can set this up later)",
      initialValue: true,
    });
    if (p.isCancel(cfDone)) cancelled();
  }

  // -----------------------------------------------------------------------
  // Step 11: Summary
  // -----------------------------------------------------------------------
  const summaryLines: string[] = [];

  summaryLines.push("Workers:");
  if (deployedUrls.core) summaryLines.push(`  Core:         ${deployedUrls.core}`);
  if (deployedUrls.subscription) summaryLines.push(`  Subscription: ${deployedUrls.subscription}`);
  if (deployedUrls.adminCore) summaryLines.push(`  Admin (core): ${deployedUrls.adminCore}`);
  if (deployedUrls.adminSubscription) summaryLines.push(`  Admin (sub):  ${deployedUrls.adminSubscription}`);
  if (Object.keys(deployedUrls).length === 0) {
    summaryLines.push("  (check your Cloudflare dashboard for URLs)");
  }

  if (repoUrl) {
    summaryLines.push("");
    summaryLines.push(`GitHub: ${repoUrl}`);
  }

  if (projectName && deployedUrls.core) {
    summaryLines.push("");
    summaryLines.push("Quick test:");
    summaryLines.push(`  curl -X PUT -H 'Authorization: Bearer <JWT>' \\`);
    summaryLines.push(`    -H 'Content-Type: application/json' \\`);
    summaryLines.push(`    ${deployedUrls.core}/v1/stream/${projectName}/test`);
  }

  p.note(summaryLines.join("\n"), "Setup complete");
  p.outro("Happy streaming!");
}
