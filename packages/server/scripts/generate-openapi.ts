import fs from "node:fs";
import path from "node:path";
import { generateSpecs } from "hono-openapi";
import { createStreamWorker } from "../src/http/router";

const outDir = path.resolve(import.meta.dirname, "..");

// --------------------------------------------------------------------------
// Wildcard-route OpenAPI definitions
// --------------------------------------------------------------------------
// hono-openapi strips paths containing `*` without `{param}` during spec
// generation (removeExcludedPaths). Routes using Hono wildcards (e.g.
// `/v1/stream/*`) are therefore defined here with proper OpenAPI parameter
// syntax so they appear in the generated spec.
// --------------------------------------------------------------------------

const streamPathParams = [
  {
    name: "projectId",
    in: "path",
    required: true,
    schema: { type: "string" },
    description: "Project identifier",
  },
  {
    name: "streamId",
    in: "path",
    required: true,
    schema: { type: "string" },
    description: "Stream identifier",
  },
];

const estuaryPathParams = [
  {
    name: "projectId",
    in: "path",
    required: true,
    schema: { type: "string" },
    description: "Project identifier",
  },
  {
    name: "estuaryId",
    in: "path",
    required: true,
    schema: { type: "string" },
    description: "Estuary identifier",
  },
];

const bearerSecurity = [{ BearerAuth: [] }];

const wildcardPaths = {
  "/v1/stream/{projectId}/{streamId}": {
    put: {
      tags: ["Streams"],
      summary: "Create stream",
      description:
        "Create a new append-only stream. The request body becomes the first message. Idempotent — re-PUT of the same stream returns 200.",
      operationId: "createStream",
      parameters: streamPathParams,
      security: bearerSecurity,
      responses: {
        201: { description: "Stream created" },
        200: { description: "Stream already exists (idempotent)" },
        409: { description: "Content-type mismatch with existing stream" },
        413: { description: "Payload too large" },
      },
    },
    post: {
      tags: ["Streams"],
      summary: "Append to stream",
      description:
        "Append a message to an existing stream. Supports idempotent producers via Producer-Id/Producer-Epoch/Producer-Seq headers.",
      operationId: "appendStream",
      parameters: streamPathParams,
      security: bearerSecurity,
      responses: {
        200: { description: "Message appended" },
        204: { description: "Stream closed (close-only append)" },
        404: { description: "Stream not found" },
        409: { description: "Content-type mismatch or stream is closed" },
        413: { description: "Payload too large" },
      },
    },
    get: {
      tags: ["Streams"],
      summary: "Read stream",
      description:
        "Read messages from a stream. Supports offset-based reads, cursors, long-poll (`?live=long-poll`), SSE (`?live=sse`), and WebSocket (`?live=ws`) for real-time tailing.",
      operationId: "readStream",
      parameters: [
        ...streamPathParams,
        {
          name: "offset",
          in: "query",
          schema: { type: "string" },
          description:
            "Stream offset to read from. Use `0000000000000000_0000000000000000` for the beginning or `now` for the current tail.",
        },
        {
          name: "cursor",
          in: "query",
          schema: { type: "string" },
          description: "Opaque cursor for paginated reads (returned in Stream-Cursor header).",
        },
        {
          name: "live",
          in: "query",
          schema: { type: "string", enum: ["long-poll", "sse", "ws"] },
          description: "Real-time delivery mode.",
        },
      ],
      security: bearerSecurity,
      responses: {
        200: { description: "Messages returned" },
        304: { description: "Not modified (conditional GET with matching ETag)" },
        404: { description: "Stream not found" },
      },
    },
    head: {
      tags: ["Streams"],
      summary: "Stream metadata",
      description: "Returns stream headers (content-type, offsets, closed status) without a body.",
      operationId: "headStream",
      parameters: streamPathParams,
      security: bearerSecurity,
      responses: {
        200: { description: "Stream headers returned" },
        404: { description: "Stream not found" },
      },
    },
    delete: {
      tags: ["Streams"],
      summary: "Delete stream",
      description:
        "Permanently delete a stream and all its data (SQLite ops, R2 segments, KV metadata).",
      operationId: "deleteStream",
      parameters: streamPathParams,
      security: bearerSecurity,
      responses: {
        204: { description: "Stream deleted" },
        404: { description: "Stream not found" },
      },
    },
  },
  "/v1/estuary/subscribe/{projectId}/{streamId}": {
    post: {
      tags: ["Estuary"],
      summary: "Subscribe estuary to a stream",
      description:
        "Subscribe an estuary to a source stream. Messages published to the source are fan-out replicated to the estuary stream.",
      operationId: "subscribeEstuary",
      parameters: streamPathParams,
      security: bearerSecurity,
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["estuaryId"],
              properties: { estuaryId: { type: "string", minLength: 1 } },
            },
          },
        },
      },
      responses: {
        200: {
          description: "Subscription created",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  estuaryId: { type: "string" },
                  streamId: { type: "string" },
                  estuaryStreamPath: { type: "string" },
                  expiresAt: { type: "number" },
                  isNewEstuary: { type: "boolean" },
                },
              },
            },
          },
        },
      },
    },
    delete: {
      tags: ["Estuary"],
      summary: "Unsubscribe estuary from a stream",
      description: "Remove an estuary's subscription to a source stream.",
      operationId: "unsubscribeEstuary",
      parameters: streamPathParams,
      security: bearerSecurity,
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["estuaryId"],
              properties: { estuaryId: { type: "string", minLength: 1 } },
            },
          },
        },
      },
      responses: {
        200: {
          description: "Unsubscribed",
          content: {
            "application/json": {
              schema: { type: "object", properties: { success: { type: "boolean" } } },
            },
          },
        },
      },
    },
  },
  "/v1/estuary/{projectId}/{estuaryId}": {
    get: {
      tags: ["Estuary"],
      summary: "Get estuary info",
      description: "Retrieve estuary metadata including subscriptions and content type.",
      operationId: "getEstuary",
      parameters: estuaryPathParams,
      security: bearerSecurity,
      responses: {
        200: {
          description: "Estuary info",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  estuaryId: { type: "string" },
                  estuaryStreamPath: { type: "string" },
                  subscriptions: {
                    type: "array",
                    items: { type: "object", properties: { streamId: { type: "string" } } },
                  },
                  contentType: { type: ["string", "null"] },
                },
              },
            },
          },
        },
      },
    },
    post: {
      tags: ["Estuary"],
      summary: "Touch estuary",
      description: "Create or extend the TTL of an estuary stream.",
      operationId: "touchEstuary",
      parameters: estuaryPathParams,
      security: bearerSecurity,
      responses: {
        200: {
          description: "Estuary touched",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  estuaryId: { type: "string" },
                  expiresAt: { type: "number" },
                },
              },
            },
          },
        },
      },
    },
    delete: {
      tags: ["Estuary"],
      summary: "Delete estuary",
      description: "Delete an estuary and its underlying stream.",
      operationId: "deleteEstuary",
      parameters: estuaryPathParams,
      security: bearerSecurity,
      responses: {
        200: {
          description: "Estuary deleted",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  estuaryId: { type: "string" },
                  deleted: { type: "boolean" },
                },
              },
            },
          },
        },
      },
    },
  },
};

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
      security: bearerSecurity,
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
      // Wildcard routes are excluded by hono-openapi's removeExcludedPaths.
      // We define them here with proper {param} syntax.
      paths: wildcardPaths as any,
    },
  });

  const jsonPath = path.join(outDir, "openapi.json");
  const yamlPath = path.join(outDir, "openapi.yaml");

  fs.writeFileSync(jsonPath, JSON.stringify(specs, null, 2) + "\n");
  console.log(`✔ Wrote ${jsonPath}`);

  // Optional YAML output — only if js-yaml is installed
  try {
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
