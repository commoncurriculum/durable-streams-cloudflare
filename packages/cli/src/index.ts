#!/usr/bin/env node

import { setup } from "./setup.js";
import { createProject } from "./create-project.js";

const HELP = `
durable-streams — CLI for Durable Streams on Cloudflare

Usage:
  durable-streams <command>

Commands:
  setup            Scaffold workers, create resources, and deploy
  create-project   Create a new project with an API key in REGISTRY KV

Options:
  --help   Show this help message
`.trim();

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    console.log(HELP);
    process.exit(command ? 0 : 1);
  }

  if (command === "setup") {
    await setup();
  } else if (command === "create-project") {
    await createProject();
  } else {
    console.error(`Unknown command: ${command}\n`);
    console.log(HELP);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
