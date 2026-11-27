import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { PrintifyClient, shopIdFromEnv, tokenFromEnv } from "../dist/client.js";
import { PrintifyInputError } from "../dist/errors.js";

const TOKEN = "super-secret-token";

interface MockResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface RecordedCall {
  url: string;
  method: string;
  body?: string;
  authorization: string | null;
  userAgent: string | null;
}

function jsonResponse(result: MockResult): Response {
  const payload = result.body === undefined ? null : JSON.stringify(result.body);
  return new Response(payload, { status: result.status, headers: result.headers });
}

function createClient(handler: (call: RecordedCall, index: number) => MockResult | Promise<MockResult>) {
  const calls: RecordedCall[] = [];
  const logs: string[] = [];
  let clock = 1_000;
  const client = new PrintifyClient({
    token: TOKEN,
    baseUrl: "https://api.test/v1/",
    defaultShopId: 7,
    maxBase64Bytes: 32,
    logger: (message) => logs.push(message),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      const call: RecordedCall = {
        url: String(input),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
        authorization: headers.get("authorization"),
        userAgent: headers.get("user-agent"),
      };
      calls.push(call);
      return jsonResponse(await handler(call, calls.length - 1));
    },
  });
  return { client, calls, logs };
}

describe("token configuration", () => {
  it("reads only PRINTIFY_API_TOKEN and does not echo a legacy key", () => {
    assert.equal(tokenFromEnv({ PRINTIFY_API_TOKEN: "  abcdefghijklmnop  " }), "abcdefghijklmnop");
    assert.throws(
      () => tokenFromEnv({ PRINTIFY_API_KEY: "legacy-secret-value" }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /PRINTIFY_API_TOKEN/);
        assert.equal(error.message.includes("legacy-secret-value"), false);
        return true;
      },
    );
    assert.equal(shopIdFromEnv({ PRINTIFY_SHOP_ID: "42" }), 42);
    assert.throws(() => shopIdFromEnv({ PRINTIFY_SHOP_ID: "shop-a" }), /numeric/);
  });

  it("does not serialize the token", () => {
    const { client } = createClient(() => ({ status: 200, body: [] }));
    assert.equal(JSON.stringify(client).includes(TOKEN), false);
    assert.equal(client.redact(`Authorization: Bearer ${TOKEN}`).includes(TOKEN), false);
  });
});

describe("HTTP behavior", () => {
  it("sends a bearer token and user agent, and retries 429 using Retry-After", async () => {
    let attempts = 0;
    const { client, calls, logs } = createClient(() => {
      attempts += 1;
      if (attempts === 1) {
        return { status: 429, body: { message: `slow down ${TOKEN}` }, headers: { "retry-after": "2" } };
      }
      return { status: 200, body: [{ id: 7, title: "Main", sales_channel: "shopify" }] };
    });
    const shops = await client.listShops();
    assert.equal(shops[0].title, "Main");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].authorization, `Bearer ${TOKEN}`);
    assert.match(calls[0].userAgent ?? "", /printify-mcp\//);
    assert.equal(calls[0].url, "https://api.test/v1/shops.json");
    assert.equal(logs.some((line) => line.includes(TOKEN)), false);
    assert.match(logs[0], /429/);
    assert.match(logs[0], /2000ms/);
  });

  it("does not retry a POST that failed with 503", async () => {
    const { client, calls } = createClient(() => ({ status: 503, body: { message: "unavailable" } }));
    await assert.rejects(
      () => client.publishProduct(7, "prod1", { title: true, description: true, images: true, variants: true, tags: true }),
      /HTTP 503/,
    );
    assert.equal(calls.length, 1);
  });

  it("retries a GET that failed with 503", async () => {
    let attempts = 0;
    const { client, calls } = createClient(() => {
      attempts += 1;
      if (attempts === 1) {
        return { status: 503, body: { message: "unavailable" } };
      }
      return { status: 200, body: { id: "img" } };
    });
    await client.getUpload("img123");
    assert.equal(calls.length, 2);
  });

  it("redacts the token in an error body and does not retry a 400", async () => {
    const { client, calls } = createClient(() => ({
      status: 400,
      body: { message: `rejected ${TOKEN}`, code: 8203, errors: { reason: "Image has low quality", code: 8203 } },
    }));
    await assert.rejects(() => client.listShops(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(TOKEN), false);
      assert.match(error.message, /Image has low quality/);
      assert.match(error.message, /8203/);
      return true;
    });
    assert.equal(calls.length, 1);
  });

  it("refuses publishing_succeeded without calling the network", async () => {
    const { client, calls } = createClient(() => ({ status: 200, body: {} }));
    await assert.rejects(
      () => client.request("POST", "shops/7/products/prod1/publishing_succeeded.json", { body: { external: {} } }),
      (error: unknown) => {
        assert.ok(error instanceof PrintifyInputError);
        assert.match(error.message, /publishing_succeeded/);
        return true;
      },
    );
    assert.equal(calls.length, 0);
  });

  it("asks for show-out-of-stock=1 only when requested", async () => {
    const { client, calls } = createClient(() => ({ status: 200, body: { variants: [] } }));
    await client.listBlueprintVariants(12, 29, true);
    await client.listBlueprintVariants(12, 29, false);
    assert.match(calls[0].url, /show-out-of-stock=1/);
    assert.equal(calls[1].url.includes("show-out-of-stock"), false);
    assert.match(calls[0].url, /catalog\/blueprints\/12\/print_providers\/29\/variants\.json/);
  });

  it("rejects a product limit above 50 before calling Printify", async () => {
    const { client, calls } = createClient(() => ({ status: 200, body: {} }));
    await assert.rejects(async () => client.listProducts(7, 1, 100), (error: unknown) => {
      assert.ok(error instanceof PrintifyInputError);
      assert.match(error.message, /1 to 50/);
      return true;
    });
    assert.equal(calls.length, 0);
  });
});

describe("shops and publishing", () => {
  it("verifies shop id and title together", async () => {
    const { client } = createClient(() => ({
      status: 200,
      body: [
        { id: 7, title: "Main Street", sales_channel: "shopify" },
        { id: 8, title: "Other", sales_channel: "disconnected" },
      ],
    }));
    const ok = await client.verifyShop({ id: 7, title: "main street" });
    assert.equal(ok.verified, true);
    assert.equal(ok.shop?.sales_channel, "shopify");
    const mismatch = await client.verifyShop({ id: 8, title: "Main Street" });
    assert.equal(mismatch.verified, false);
    assert.match(mismatch.reason, /Other/);
    assert.match(mismatch.reason, /disconnected/);
  });

  it("polls until an absolute storefront URL exists and never marks a relative handle as published", async () => {
    const products = [
      { id: "prod1", title: "Tee", external: { handle: "/products/tee" }, is_locked: true },
      { id: "prod1", title: "Tee", external: { id: "99", handle: "https://shop.example/products/tee" }, is_locked: false },
    ];
    let gets = 0;
    const { client, calls } = createClient((call) => {
      if (call.method === "POST") {
        return { status: 200, body: {} };
      }
      const product = products[Math.min(gets, products.length - 1)];
      gets += 1;
      return { status: 200, body: product };
    });
    const result = await client.publishAndWait(
      7,
      "prod1",
      { title: true, description: true, images: true, variants: true, tags: true },
      { timeoutMs: 10_000, intervalMs: 1_000 },
    );
    assert.equal(result.published, true);
    assert.equal(result.storefrontUrl, "https://shop.example/products/tee");
    assert.equal(result.attempts, 2);
    assert.equal(calls.some((call) => call.url.includes("publishing_succeeded")), false);
    assert.equal(calls.some((call) => call.url.includes("publishing_failed")), false);
    assert.equal(calls[0].method, "POST");
    assert.match(calls[0].url, /\/publish\.json$/);
    const sent = JSON.parse(calls[0].body ?? "{}") as Record<string, boolean>;
    assert.equal(sent.title, true);
    assert.equal(sent.shipping_template, undefined);
  });

  it("returns pending when the storefront URL never appears", async () => {
    const { client, calls } = createClient((call) => {
      if (call.method === "POST") {
        return { status: 200, body: {} };
      }
      return { status: 200, body: { id: "prod1", title: "Tee", is_locked: true, external: null } };
    });
    const result = await client.publishAndWait(
      7,
      "prod1",
      { title: true, description: true, images: true, variants: true, tags: true },
      { timeoutMs: 2_000, intervalMs: 1_000 },
    );
    assert.equal(result.published, false);
    assert.equal(result.storefrontUrl, null);
    assert.match(result.message, /publishing_succeeded/);
    assert.equal(calls.filter((call) => call.method === "GET").length >= 2, true);
  });

  it("finds a product by title and stops at the last page", async () => {
    const { client, calls } = createClient((call) => {
      const page = new URL(call.url).searchParams.get("page");
      if (page === "1") {
        return {
          status: 200,
          body: {
            current_page: 1,
            last_page: 2,
            next_page_url: "/?page=2",
            total: 2,
            data: [{ id: "a", title: "Other", tags: [], variants: [], blueprint_id: 1, print_provider_id: 1 }],
          },
        };
      }
      return {
        status: 200,
        body: {
          current_page: 2,
          last_page: 2,
          next_page_url: null,
          total: 2,
          data: [{ id: "b", title: "Horizon Tee", tags: ["drop-1"], variants: [], blueprint_id: 1, print_provider_id: 1 }],
        },
      };
    });
    const found = await client.findProducts(7, { title: "  horizon   tee " });
    assert.equal(found.truncated, false);
    assert.equal(found.matches[0].id, "b");
    assert.equal(calls.length, 2);
    const tagged = await client.findProducts(7, { tag: "drop-1", maxPages: 1 });
    assert.equal(tagged.truncated, true);
    assert.equal(tagged.matches.length, 0);
  });
});

describe("uploads", () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("uploads by URL without base64 contents", async () => {
    const { client, calls } = createClient(() => ({
      status: 200,
      body: { id: "img1", file_name: "art.png", height: 1, width: 1, size: 1, mime_type: "image/png", preview_url: "https://cdn.example/art.png", upload_time: "2020-01-01 00:00:00" },
    }));
    const image = await client.uploadImage({ fileName: "art.png", url: "https://cdn.example/art.png" });
    assert.equal(image.id, "img1");
    assert.deepEqual(JSON.parse(calls[0].body ?? "{}"), {
      file_name: "art.png",
      url: "https://cdn.example/art.png",
    });
  });

  it("uploads a local file as base64 and strips a data URL prefix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "printify-mcp-"));
    tempDirs.push(dir);
    const filePath = join(dir, "tiny.png");
    await writeFile(filePath, Buffer.from("hello"));
    const { client, calls } = createClient(() => ({
      status: 200,
      body: { id: "img2", file_name: "tiny.png", height: 1, width: 1, size: 5, mime_type: "image/png", preview_url: "https://cdn.example/tiny.png", upload_time: "2020-01-01 00:00:00" },
    }));
    await client.uploadImage({ fileName: "tiny.png", filePath });
    assert.equal(JSON.parse(calls[0].body ?? "{}").contents, Buffer.from("hello").toString("base64"));
    await client.uploadImage({
      fileName: "from-data.png",
      contents: `data:image/png;base64,${Buffer.from("hi").toString("base64")}`,
    });
    assert.equal(JSON.parse(calls[1].body ?? "{}").contents, Buffer.from("hi").toString("base64"));
  });

  it("refuses a base64 payload over the size limit", async () => {
    const { client, calls } = createClient(() => ({ status: 200, body: {} }));
    await assert.rejects(
      () => client.uploadImage({ fileName: "big.png", contents: Buffer.alloc(64).toString("base64") }),
      /5MB|bytes/,
    );
    assert.equal(calls.length, 0);
  });
});
