import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      inspectorPort: Number(process.env.CF_INSPECTOR_PORT ?? 9231),
    }),
    tanstackStart(),
    react(),
    tailwindcss(),
  ],
});
