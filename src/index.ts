#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PrintifyClient, shopIdFromEnv, tokenFromEnv } from "./client.js";
import { createPrintifyServer } from "./server.js";

export { PrintifyClient, shopIdFromEnv, tokenFromEnv, storefrontUrlFromExternal } from "./client.js";
export { PrintifyApiError, PrintifyConfigError, PrintifyInputError } from "./errors.js";
export { buildProductFromTemplate } from "./product-payload.js";
export { createPrintifyServer } from "./server.js";

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

async function main(): Promise<void> {
  let token: string;
  let defaultShopId: number | undefined;
  try {
    token = tokenFromEnv();
    defaultShopId = shopIdFromEnv();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }

  const client = new PrintifyClient({ token, defaultShopId });
  const server = createPrintifyServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("printify-mcp is listening on stdio.");
}

if (isDirectRun()) {
  await main();
}
