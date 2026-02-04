import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";

export default defineConfig({
  plugins: [
    tailwindcss(),
    TanStackRouterVite({ autoCodeSplitting: true }),
    react(),
  ],
  base: "/admin/",
  build: {
    outDir: "../dist/admin-ui",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/admin/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
      "/v1": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
