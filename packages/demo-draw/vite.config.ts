import path from "node:path";
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      inspectorPort: Number(process.env.CF_INSPECTOR_PORT ?? 9234),
      persistState: { path: "../../.wrangler/state" },
    }),
    tanstackStart(),
    react(),
    tailwindcss(),
  ],
});
