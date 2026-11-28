# Printify MCP Server

MCP server for the [Printify REST API](https://developers.printify.com/). An assistant can list shops, read a product as a template, browse the catalog (including print-area dimensions and shipping), upload artwork, create or update a product, and publish it until a storefront URL exists.

This repository is a fork of [TSavo/printify-mcp](https://github.com/TSavo/printify-mcp). Image generation is not part of the server. Upload artwork you already have, by URL, base64, or a local file.

## Setup

Requirements:

- Node.js 18 or newer (Node.js 22 to run the TypeScript tests)
- A Printify personal access token with scopes `shops.read`, `catalog.read`, `products.read`, `products.write`, `uploads.read`, and `uploads.write`

Create the token in Printify under **My Profile → Connections**. It is shown once. Put it in the MCP client `env` block as `PRINTIFY_API_TOKEN`. The server does not read a `.env` file, does not accept the token as a tool argument, and does not log it. `PRINTIFY_API_KEY` is ignored.

```bash
git clone https://github.com/k7cfo/printify-mcp.git
cd printify-mcp
npm install
npm test
```

`npm test` builds `dist/` and runs the mocked HTTP tests. Start the server with:

```bash
PRINTIFY_API_TOKEN=your_token npm start
```

Optional: `PRINTIFY_SHOP_ID` selects a shop. When it is unset, shop tools use the account only if it has exactly one shop. Otherwise pass `shopId`.

### Claude Desktop

Add this to `claude_desktop_config.json` (`~/Library/Application Support/Claude/` on macOS, `%APPDATA%\Claude\` on Windows):

```json
{
  "mcpServers": {
    "printify": {
      "command": "node",
      "args": ["/absolute/path/to/printify-mcp/dist/index.js"],
      "env": {
        "PRINTIFY_API_TOKEN": "your_token",
        "PRINTIFY_SHOP_ID": "12345"
      }
    }
  }
}
```

`PRINTIFY_SHOP_ID` is optional. Omit it to choose the shop from `list_shops`.

### Cursor

Add the same `mcpServers.printify` entry to `~/.cursor/mcp.json` (or the project `.cursor/mcp.json`).

### Generic MCP client

Any client that speaks stdio MCP can run `node /absolute/path/to/dist/index.js` with `PRINTIFY_API_TOKEN` in the process environment. The process speaks MCP on stdin and stdout. Diagnostics go to stderr only.

### Docker

```bash
docker build -t printify-mcp .
docker run -i --rm -e PRINTIFY_API_TOKEN=your_token printify-mcp
```

Point the MCP client at `docker run -i --rm -e PRINTIFY_API_TOKEN=... printify-mcp`. Do not allocate a TTY if the client needs raw stdio.

## Tools

| Tool | What it does |
| --- | --- |
| `list_shops` | Shop id, title, and sales channel |
| `verify_shop` | Check that an id and title are the same shop |
| `list_blueprints` | Catalog blueprints, with a local title/brand/model search |
| `get_blueprint` | One blueprint, including tags, features, and care instructions |
| `get_blueprint_size_guide` | Size guide, or empty arrays when none exists |
| `list_print_providers` | All print providers |
| `get_print_provider` | One provider and the blueprints it offers |
| `list_blueprint_print_providers` | Providers that fulfill one blueprint |
| `get_blueprint_variants` | Variants and placeholder width, height, and decoration method |
| `get_blueprint_shipping` | Handling time and shipping cost profiles |
| `list_products` | Product summaries. Page size is at most 50 |
| `get_product` | Full product: print areas, variant prices, mockups |
| `get_product_mockups` | Mockup image URLs only |
| `find_products` | Exact title and/or tag match by scanning product pages |
| `create_product_from_template` | Copy blueprint, provider, enabled variants, and prices; replace one print position |
| `create_product` | Create from writable fields |
| `update_product` | Title, description, tags, print areas, and/or the full variant list |
| `publish_product` | Publish, then poll until `external.handle` is an http(s) URL |
| `get_publish_status` | Read that URL again without publishing |
| `unpublish_product` | `POST .../unpublish.json`. Requires `confirm: true` |
| `delete_product` | Delete. Requires `confirm: true` |
| `upload_image` | Media library upload by URL, base64, or local file |
| `list_uploads` | Media library page |
| `get_upload` | One uploaded image |
| `archive_upload` | Archive an upload. Requires `confirm: true` |

There is also a `generate_product_description` prompt. It only drafts text. It does not call Printify.

## Examples

Confirm the shop before changing anything:

```json
{ "tool": "list_shops" }
{ "tool": "verify_shop", "arguments": { "shopId": 12345, "title": "Main Street" } }
```

`verified` is true only when that id and title are the same shop. `sales_channel` is the connected channel (`shopify`, `etsy`, `disconnected`, and so on).

Read a product you want to copy:

```json
{ "tool": "get_product", "arguments": { "productId": "5d39b159e7c48c000728c89f" } }
```

The response includes `print_areas`, variant `id` / `price` (integer cents) / `is_enabled`, and mockup `images`.

Look up a blank, its printer, print-area size, and shipping:

```json
{ "tool": "list_blueprints", "arguments": { "search": "unisex jersey", "limit": 10 } }
{ "tool": "list_blueprint_print_providers", "arguments": { "blueprintId": 12 } }
{ "tool": "get_blueprint_variants", "arguments": { "blueprintId": 12, "printProviderId": 29, "size": "M" } }
{ "tool": "get_blueprint_shipping", "arguments": { "blueprintId": 12, "printProviderId": 29 } }
```

Each variant placeholder has `position`, `width`, `height`, and `decoration_method`. Use that `position` string when placing art. The decoration method is chosen by the position. It is read-only and is not sent on create.

Upload artwork, then create from the template. Scale `1` fills the placeholder width. `x` and `y` use a 0–1 coordinate system whose center is `0.5, 0.5`.

```json
{ "tool": "upload_image", "arguments": { "fileName": "front.png", "url": "https://example.com/front.png" } }
{ "tool": "upload_image", "arguments": { "fileName": "front.png", "filePath": "/absolute/path/front.png" } }
```

```json
{
  "tool": "create_product_from_template",
  "arguments": {
    "templateProductId": "5d39b159e7c48c000728c89f",
    "title": "Horizon City Tee",
    "idempotencyTag": "horizon-city-tee",
    "imageId": "5941187eb8e7e37b3f0e62e5",
    "position": "front",
    "x": 0.5,
    "y": 0.5,
    "scale": 1,
    "angle": 0
  }
}
```

If a product already has that tag, the tool returns it and does not create another. Set `matchExisting` to false only when a duplicate is intentional. `find_products` does the same scan on its own.

Update copy or the front print:

```json
{
  "tool": "update_product",
  "arguments": {
    "productId": "5d39b411749d0a000f30e0f4",
    "title": "Horizon City Tee",
    "description": "Updated description",
    "tags": ["horizon-city-tee", "tee"],
    "printAreas": [
      {
        "variant_ids": [18100, 18101],
        "placeholders": [
          {
            "position": "front",
            "images": [{ "id": "5941187eb8e7e37b3f0e62e5", "x": 0.5, "y": 0.4, "scale": 0.85, "angle": 0 }]
          }
        ]
      }
    ]
  }
}
```

When `variants` is included, send every variant. Printify rejects a partial variant list. Prices are integer cents.

Publish and wait for the sales channel URL:

```json
{
  "tool": "publish_product",
  "arguments": { "productId": "5d39b411749d0a000f30e0f4", "timeoutMs": 45000, "intervalMs": 3000 }
}
```

`published` is true only when `storefrontUrl` is an absolute `http` or `https` URL from `external.handle`. If the call times out, poll with `get_publish_status`. Do not publish again while `is_locked` is true.

```json
{ "tool": "get_product_mockups", "arguments": { "productId": "5d39b411749d0a000f30e0f4" } }
{ "tool": "unpublish_product", "arguments": { "productId": "5d39b411749d0a000f30e0f4", "confirm": true } }
{ "tool": "delete_product", "arguments": { "productId": "5d39b411749d0a000f30e0f4", "confirm": true } }
{ "tool": "archive_upload", "arguments": { "imageId": "5941187eb8e7e37b3f0e62e5", "confirm": true } }
```

## Real-world speed

We built one real product with this server to see what it feels like: a double-sided luggage tag (blueprint 910) for the K7CFO shop, from "pick the blank" to a draft with mockups. It was created unpublished, and nothing was published to the storefront.

One assistant ran every Printify step through the MCP tools: `verify_shop`, `find_products` (duplicate check), `get_blueprint`, `list_blueprint_print_providers`, `get_blueprint_variants` (to read the 960 x 1335 px print area), `upload_image`, `create_product`, `update_product` (price), and `get_product_mockups`. Wall-clock times from a `date +%s` stopwatch:

| Step | Time |
| --- | --- |
| Verify shop, duplicate check, read blueprint, providers and print area | about 25 s |
| Lay out the artwork (photo crop, caption, check by eye) | about 30 s |
| Upload | about 10 s |
| Create the draft | about 10 s |
| Set price from the real cost, fetch and save mockups | about 20 s |
| **First complete draft, start to saved mockup** | **98 s** |

Those times include the assistant reading tool schemas and deciding what to call next, so they are end-to-end, not raw API latency. The first mockup showed the caption too close to the trimmed edge, so we re-laid the art, re-uploaded and updated the print area. That fix took another 60 s, for 158 s total. Each connector call came back in about a second or two.

How that compares:

- **Raw API scripts.** Earlier the same day, the same assistant did shirt batches with hand-written Python against the REST API. Those runs uploaded 4 images and created 2 products in 21 s, and uploaded 6 images and created 3 products in 23 s (read from the upload and product ID timestamps). So the connector is not faster at the network level. Both talk to the same API. What the connector saves is writing, debugging and re-running a script for each product type, and the built-in `find_products` and `verify_shop` guardrails.
- **Driving the Printify website in a browser.** We do not have a reliable timed baseline, so we are not claiming a number. The browser path means clicking through the product editor one screen at a time, which is why we only use it for things the API does not offer, such as collections and store navigation.

The honest summary: for a product with a hand-made design, most of the time went into the design, not the Printify calls. Creating the draft and getting mockups back took about 40 seconds.

## API behavior this server follows

Checked against the live [Printify API reference](https://developers.printify.com/) (the docs page’s own history line still says October 2024; the reference itself now includes decoration methods, economy shipping, GPSR, and mockup selection).

- Base URL `https://api.printify.com/v1/`. Requests use `Authorization: Bearer` and a `User-Agent`. The API requires both.
- Global limit 600 requests/minute. Catalog routes also allow 100 requests/minute. Publishing allows 200 requests per 30 minutes. A `429` is retried using `Retry-After` when present, otherwise exponential backoff capped at 60 seconds. `GET`, `PUT`, and `DELETE` also retry `502` and `503`. `POST` is retried only on `429`, so a timeout cannot duplicate a product, upload, or publish.
- `GET /v1/shops.json` returns id, title, and `sales_channel`. There is no separate “get shop” endpoint.
- `GET /v1/catalog/blueprints.json` returns the whole catalog in one array. `search` and `limit` on `list_blueprints` run locally. Blueprint tags and care instructions are only on the single-blueprint endpoint.
- Variant `placeholders` carry print-area `width` and `height` in pixels. `show-out-of-stock` accepts only `0` or `1`. Omitting it returns in-stock variants. Shipping is `GET .../shipping.json` (handling time plus per-country first-item and additional-item costs in cents).
- Create accepts blueprint id, print provider id, variants (`id`, `price`, `is_enabled`), and `print_areas` (`variant_ids`, placeholders, images with `id`, `x`, `y`, `scale`, `angle`). Mockup images, options, timestamps, costs, and `decoration_method` are read-only. The template tool does not send them. `blueprint_id` and `print_provider_id` are required on create and read-only after that.
- Product list `limit` max is 50. There is no title or tag query parameter, so `find_products` scans pages. A truncated scan refuses to create, so an existing product on a later page is not missed.
- `POST .../publish.json` does not itself publish to a custom store. For a connected sales channel it locks the product until `external.handle` is set. For a custom integration the product stays locked until that channel calls `publishing_succeeded`, or for about an hour. This server never calls `publishing_succeeded` or `publishing_failed`, because that would record success without a storefront URL. A relative handle such as `/products/tee` is reported and is not treated as the storefront URL.
- Mockup URLs are the read-only `images[].src` values on the product.
- Uploads: `POST /v1/uploads/images.json` with either `url` or base64 `contents`. Base64 and local files larger than 5MB are refused. Printify recommends URL upload above that size and plans to drop larger base64 uploads. Archive is `POST /v1/uploads/{id}/archive.json`.
- `POST .../unpublish.json` returns 400 when the product was not published. Delete returns 409 while a product is syncing from its sales channel.
- Printify does not document a collections resource. Shopify collection names can appear on a product as `sales_channel_properties.collections`. The template tool can copy that object. It does not invent a collections API.
- Orders, webhooks, and the v2 shipping catalog are not exposed. On-the-fly product creation during order submit is documented as something to avoid.

## Development

```bash
npm test
npm start
```

Tests use Node’s test runner and a mocked `fetch`. They do not call Printify.

## License

ISC. Original project by TSavo.
