import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: [
    "./src/storage/stream-do/schema.ts",
    "./src/storage/estuary-do/schema.ts",
    "./src/storage/stream-subscribers-do/schema.ts",
  ],
  out: "./drizzle",
  dialect: "sqlite",
  driver: "d1-http",
});
