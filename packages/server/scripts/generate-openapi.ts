import fs from "node:fs";
import path from "node:path";
import { generateSpecs } from "hono-openapi";
import { createStreamWorker } from "../src/http/router";

const outDir = path.resolve(import.meta.dirname, "..");

async function main() {
  const { app } = createStreamWorker();

  const specs = await generateSpecs(app, {
    documentation: {
      info: {
        title: "Durable Streams API",
        version: "0.8.0",
        description:
          "Durable Streams on Cloudflare — append-only event streams with pub/sub fan-out.",
      },
      servers: [{ url: "http://localhost:8787", description: "Local development" }],
      security: [{ BearerAuth: [] }],
      components: {
        securitySchemes: {
          BearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
            description:
              "Per-project HMAC-SHA256 JWT. Claims: sub (project ID), scope (read|write|manage), exp.",
          },
        },
      },
    },
  });

  const jsonPath = path.join(outDir, "openapi.json");
  const yamlPath = path.join(outDir, "openapi.yaml");

  fs.writeFileSync(jsonPath, JSON.stringify(specs, null, 2) + "\n");
  console.log(`✔ Wrote ${jsonPath}`);

  // Optional YAML output — only if js-yaml is installed
  try {
    // @ts-expect-error js-yaml is an optional dependency
    const yaml = await import("js-yaml");
    fs.writeFileSync(yamlPath, yaml.dump(specs));
    console.log(`✔ Wrote ${yamlPath}`);
  } catch {
    console.log("ℹ Skipping YAML output (install js-yaml for YAML support)");
  }
}

main().catch((err) => {
  console.error("Failed to generate OpenAPI spec:", err);
  process.exit(1);
});
