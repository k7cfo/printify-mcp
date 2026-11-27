import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as actions from "../dist/actions.js";
import { PrintifyClient } from "../dist/client.js";
import { createPrintifyServer } from "../dist/server.js";
import type { PrintifyProduct } from "../dist/types.js";

const TOKEN = "super-secret-token";

function templateProduct(): PrintifyProduct {
  return {
    id: "template1",
    title: "Template Tee",
    description: "Soft tee",
    tags: ["template"],
    blueprint_id: 12,
    print_provider_id: 29,
    visible: true,
    variants: [
      { id: 18100, price: 2499, is_enabled: true, is_default: true, title: "Black / S" },
      { id: 18101, price: 2499, is_enabled: false, title: "Black / M" },
    ],
    print_areas: [
      {
        variant_ids: [18100, 18101],
        placeholders: [
          {
            position: "front",
            decoration_method: "dtg",
            images: [{ id: "old", x: 0.5, y: 0.5, scale: 1, angle: 0, src: "https://cdn.example/old.png" }],
          },
        ],
      },
    ],
    images: [
      { src: "https://images.example/mockup.jpg", mockup_id: "m1", variant_ids: [18100], position: "front", is_default: true },
    ],
  };
}

function route(url: string, method: string, body: string | undefined, state: { created: boolean }): { status: number; body: unknown } {
  const parsed = new URL(url);
  const path = parsed.pathname;
  if (path.endsWith("/shops.json")) {
    return { status: 200, body: [{ id: 7, title: "Main Street", sales_channel: "shopify" }] };
  }
  if (path.endsWith("/products.json") && method === "GET") {
    const page = parsed.searchParams.get("page");
    return {
      status: 200,
      body: {
        current_page: Number(page ?? 1),
        last_page: 1,
        total: state.created ? 1 : 0,
        data: state.created
          ? [{ id: "existing", title: "Horizon Tee", tags: ["run-1"], variants: [{ id: 1, price: 2000, is_enabled: true }], blueprint_id: 12, print_provider_id: 29 }]
          : [],
      },
    };
  }
  if (path.endsWith("/products/template1.json") && method === "GET") {
    return { status: 200, body: templateProduct() };
  }
  if (path.endsWith("/products.json") && method === "POST") {
    const sent = JSON.parse(body ?? "{}") as { title?: string; print_areas?: Array<{ placeholders?: Array<{ decoration_method?: string; images?: Array<{ id?: string; scale?: number }> }> }> };
    assert.equal(sent.print_areas?.[0].placeholders?.[0].decoration_method, undefined);
    assert.equal(sent.print_areas?.[0].placeholders?.[0].images?.[0].id, "art-1");
    assert.equal(sent.print_areas?.[0].placeholders?.[0].images?.[0].scale, 0.75);
    return { status: 200, body: { ...templateProduct(), id: "created1", title: sent.title } };
  }
  if (path.endsWith("/products/created1.json") && method === "PUT") {
    return { status: 200, body: { ...templateProduct(), id: "created1", title: "Updated" } };
  }
  if (path.endsWith("/products/created1.json") && method === "DELETE") {
    return { status: 200, body: {} };
  }
  if (path.endsWith("/products/created1/publish.json") && method === "POST") {
    return { status: 200, body: {} };
  }
  if (path.endsWith("/products/created1.json") && method === "GET") {
    return {
      status: 200,
      body: {
        ...templateProduct(),
        id: "created1",
        external: { id: "shop-1", handle: "https://shop.example/products/horizon" },
        is_locked: false,
      },
    };
  }
  if (path.endsWith("/products/created1/unpublish.json")) {
    return { status: 200, body: {} };
  }
  if (path.endsWith("/uploads/images.json")) {
    const sent = JSON.parse(body ?? "{}") as { url?: string; contents?: string };
    assert.equal(Boolean(sent.url) !== Boolean(sent.contents), true);
    return {
      status: 200,
      body: { id: "art-1", file_name: "art.png", height: 10, width: 10, size: 10, mime_type: "image/png", preview_url: "https://cdn.example/art.png", upload_time: "2020-01-01 00:00:00" },
    };
  }
  if (path.endsWith("/uploads/art-1/archive.json")) {
    return { status: 200, body: {} };
  }
  return { status: 404, body: { error: `no route ${method} ${path}` } };
}

function testClient(): { client: PrintifyClient; calls: string[] } {
  const calls: string[] = [];
  const state = { created: false };
  const client = new PrintifyClient({
    token: TOKEN,
    baseUrl: "https://api.test/v1/",
    sleep: async () => undefined,
    now: () => Date.now(),
    fetch: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (method === "POST" && url.includes("/products.json")) {
        state.created = true;
      }
      const result = route(url, method, typeof init?.body === "string" ? init.body : undefined, state);
      return new Response(JSON.stringify(result.body), { status: result.status });
    },
  });
  return { client, calls };
}

function textOf(result: { content: unknown }): string {
  const content = result.content as Array<{ text?: string }>;
  return content.map((part) => part.text ?? "").join("\n");
}

describe("print on demand workflow", () => {
  it("creates from a template only when no matching title exists, then updates", async () => {
    const { client, calls } = testClient();
    const created = await actions.createProductFromTemplate(client, {
      templateProductId: "template1",
      title: "Horizon Tee",
      imageId: "art-1",
      scale: 0.75,
      idempotencyTag: "run-1",
    });
    assert.equal(created.created, true);
    if (!created.created) {
      return;
    }
    assert.equal(created.product.id, "created1");
    assert.equal(JSON.stringify(created.sent).includes(TOKEN), false);
    assert.equal(calls.some((call) => call.includes("publishing_succeeded")), false);

    const duplicate = await actions.createProductFromTemplate(client, {
      templateProductId: "template1",
      title: "Horizon Tee",
      imageId: "art-1",
      idempotencyTag: "run-1",
    });
    assert.equal(duplicate.created, false);

    const updated = await actions.updateProduct(client, {
      productId: "created1",
      title: "Updated Horizon Tee",
      description: "New copy",
      tags: ["run-1", "tee"],
      printAreas: [
        {
          variant_ids: [18100],
          placeholders: [
            {
              position: "front",
              decoration_method: "dtg",
              images: [{ id: "art-1", x: 0.2, y: 0.3, scale: 0.9, angle: 0, src: "https://cdn.example/ignore.png" }],
            },
          ],
        },
      ],
    });
    assert.equal(updated.sent.title, "Updated Horizon Tee");
    assert.equal(JSON.stringify(updated.sent).includes("decoration_method"), false);
    assert.equal(JSON.stringify(updated.sent).includes("src"), false);
  });

  it("publishes by polling and reads mockups without faking success", async () => {
    const { client, calls } = testClient();
    const published = await actions.publishProduct(client, { productId: "created1", timeoutMs: 0 });
    assert.equal(published.published, true);
    assert.equal(published.storefrontUrl, "https://shop.example/products/horizon");
    assert.equal(calls.some((call) => call.includes("publishing_succeeded")), false);

    const mockups = await actions.getProductMockups(client, { productId: "created1" });
    assert.equal(mockups.mockups[0].src, "https://images.example/mockup.jpg");

    const removed = await actions.unpublishProduct(client, { productId: "created1", confirm: true });
    assert.equal(removed.unpublished, true);
    await assert.rejects(
      () => actions.deleteProduct(client, { productId: "created1", confirm: false as unknown as true }),
      /confirm: true/,
    );
  });
});

describe("MCP server", () => {
  it("registers the workflow tools and requires confirmation to delete", async () => {
    const { client } = testClient();
    const server = createPrintifyServer(client);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "printify-test", version: "0.0.0" });
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);

    const listed = await mcp.listTools();
    const names = listed.tools.map((tool) => tool.name);
    for (const name of [
      "list_shops",
      "verify_shop",
      "list_blueprints",
      "get_blueprint_variants",
      "get_blueprint_shipping",
      "get_product",
      "find_products",
      "create_product_from_template",
      "update_product",
      "publish_product",
      "get_publish_status",
      "upload_image",
      "list_uploads",
      "archive_upload",
      "unpublish_product",
      "delete_product",
    ]) {
      assert.equal(names.includes(name), true, name);
    }
    for (const absent of ["generate_image", "generate_and_upload_image", "list_collections", "publishing_succeeded", "how_to_use"]) {
      assert.equal(names.includes(absent), false, absent);
    }

    const shops = await mcp.callTool({ name: "list_shops", arguments: {} });
    const shopText = textOf(shops);
    assert.match(shopText, /Main Street/);
    assert.equal(shopText.includes(TOKEN), false);

    const verify = await mcp.callTool({
      name: "verify_shop",
      arguments: { shopId: 7, title: "Main Street" },
    });
    assert.match(textOf(verify), /"verified": true/);

    const missingConfirm = await mcp.callTool({
      name: "delete_product",
      arguments: { productId: "created1" },
    });
    assert.equal(missingConfirm.isError, true);

    const denied = await mcp.callTool({
      name: "delete_product",
      arguments: { productId: "created1", confirm: false },
    });
    assert.equal(denied.isError, true);

    const deleted = await mcp.callTool({
      name: "delete_product",
      arguments: { productId: "created1", confirm: true },
    });
    assert.equal(deleted.isError, undefined);
    assert.match(textOf(deleted), /"deleted": true/);

    await mcp.close();
    await server.close();
  });
});
