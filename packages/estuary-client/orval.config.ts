import { defineConfig } from "orval";

export default defineConfig({
	"estuary-client": {
		input: {
			target: "../server/openapi.json",
		},
		output: {
			target: "./src/generated/client.ts",
			client: "react-query",
			mode: "single",
			clean: true,
			prettier: false,
			baseUrl: "http://localhost:8787",
		},
	},
});
