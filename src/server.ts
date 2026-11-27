import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as actions from "./actions.js";
import { PrintifyClient } from "./client.js";
import { SERVER_VERSION } from "./version.js";

const shopId = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Shop id from list_shops. Defaults to PRINTIFY_SHOP_ID when that shop exists, or the only shop on the account.");

function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

export function createPrintifyServer(client: PrintifyClient): McpServer {
  const server = new McpServer({
    name: "printify-mcp",
    version: SERVER_VERSION,
  });

  const tool = <Args extends z.ZodRawShape>(
    name: string,
    config: {
      title: string;
      description: string;
      inputSchema?: Args;
      annotations?: {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
      };
    },
    handler: (args: z.infer<z.ZodObject<Args>>) => Promise<unknown>,
  ) => {
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: (config.inputSchema ?? {}) as Args,
        annotations: { openWorldHint: true, ...config.annotations },
      },
      (async (args: z.infer<z.ZodObject<Args>>) => {
        try {
          return textResult(await handler(args));
        } catch (error) {
          return errorResult(error);
        }
      }) as Parameters<McpServer["registerTool"]>[2],
    );
  };

  tool("list_shops", {
    title: "List shops",
    description:
      "List Printify shops for this token: id, title, and sales_channel (shopify, etsy, woocommerce, ebay, tiktok, custom_integration, disconnected, or another channel). Use this before any shop-scoped call and compare the title so you are in the intended shop.",
    annotations: { readOnlyHint: true },
  }, () => actions.listShops(client));

  tool(
    "verify_shop",
    {
      title: "Verify shop identity",
      description:
        "Confirm a shop id and title refer to the same shop, and report its sales channel. verified is true only when the requested identity matches the live shop list. A disconnected shop can be listed but usually cannot publish to a storefront.",
      inputSchema: {
        shopId: z.number().int().positive().optional().describe("Shop id to check."),
        title: z.string().optional().describe("Expected shop title. Compared case-insensitively."),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => actions.verifyShop(client, args),
  );

  tool(
    "list_blueprints",
    {
      title: "List catalog blueprints",
      description:
        "List Printify catalog blueprints (blank products). The API returns the entire catalog in one call and does not paginate. search filters title, brand, and model locally. Follow with get_blueprint, then print providers and variants.",
      inputSchema: {
        search: z.string().optional().describe("Case-insensitive substring of title, brand, or model."),
        limit: z.number().int().min(1).max(200).optional().describe("Local cap on returned rows. Default 50."),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => actions.listBlueprints(client, args),
  );

  tool(
    "get_blueprint",
    {
      title: "Get blueprint",
      description:
        "Get one catalog blueprint, including description, brand, model, tags, features, and care instructions when Printify provides them.",
      inputSchema: { blueprintId: z.number().int().positive().describe("Blueprint id.") },
      annotations: { readOnlyHint: true },
    },
    (args) => actions.getBlueprint(client, args.blueprintId),
  );

  tool(
    "get_blueprint_size_guide",
    {
      title: "Get blueprint size guide",
      description: "Get the size guide for a blueprint. Empty sizes and types mean the blueprint has no size guide.",
      inputSchema: { blueprintId: z.number().int().positive() },
      annotations: { readOnlyHint: true },
    },
    (args) => actions.getBlueprintSizeGuide(client, args.blueprintId),
  );

  tool(
    "list_print_providers",
    {
      title: "List print providers",
      description: "List print providers in the catalog, including location. This is not filtered by blueprint.",
      annotations: { readOnlyHint: true },
    },
    () => actions.listPrintProviders(client),
  );

  tool(
    "get_print_provider",
    {
      title: "Get print provider",
      description: "Get one print provider and the blueprints it offers.",
      inputSchema: { printProviderId: z.number().int().positive() },
      annotations: { readOnlyHint: true },
    },
    (args) => actions.getPrintProvider(client, args.printProviderId),
  );

  tool(
    "list_blueprint_print_providers",
    {
      title: "List blueprint print providers",
      description:
        "List print providers that fulfill a blueprint, with decoration methods and average production time. A missing blueprint returns 404.",
      inputSchema: { blueprintId: z.number().int().positive() },
      annotations: { readOnlyHint: true },
    },
    (args) => actions.listBlueprintPrintProviders(client, args.blueprintId),
  );

  tool(
    "get_blueprint_variants",
    {
      title: "Get blueprint variants and print areas",
      description:
        "List variants for a blueprint and print provider. Each variant includes placeholders (print areas) with position, decoration method, and width/height in pixels. Decoration method is chosen by position and cannot be sent when creating a product. By default only in-stock variants are returned; set showOutOfStock to include the rest. Optional size and color filters are applied locally.",
      inputSchema: {
        blueprintId: z.number().int().positive(),
        printProviderId: z.number().int().positive(),
        showOutOfStock: z.boolean().optional().describe("When true, sends show-out-of-stock=1. The API accepts only 0 or 1."),
        size: z.string().optional().describe("Keep variants whose options.size matches, case-insensitively."),
        color: z.string().optional().describe("Keep variants whose options.color matches, case-insensitively."),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => actions.getBlueprintVariants(client, args),
  );

  tool(
    "get_blueprint_shipping",
    {
      title: "Get blueprint shipping",
      description:
        "Get handling time and shipping profiles (first item and additional item cost in cents, by country) for every variant of a blueprint at a print provider.",
      inputSchema: {
        blueprintId: z.number().int().positive(),
        printProviderId: z.number().int().positive(),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => actions.getBlueprintShipping(client, args.blueprintId, args.printProviderId),
  );

  tool(
    "list_products",
    {
      title: "List products",
      description:
        "List products in a shop as short summaries (id, title, tags, price range, lock and external handle). Page size is at most 50. Use get_product for print areas, variants, and mockups.",
      inputSchema: {
        shopId,
        page: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(50).optional().describe("Default 10. Printify's maximum is 50."),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => actions.listProducts(client, args),
  );

  tool(
    "get_product",
    {
      title: "Get product",
      description:
        "Read one product, including print_areas, variants (id, price in cents, is_enabled), tags, and mockup images. Use this as the template before create_product_from_template. Do not copy read-only fields such as id, images, options, created_at, or decoration_method into a create call; the template tool strips them.",
      inputSchema: {
        shopId,
        productId: z.string().describe("Printify product id."),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => actions.getProduct(client, args),
  );

  tool(
    "get_product_mockups",
    {
      title: "Get product mockup URLs",
      description:
        "Return mockup image URLs for a product (src, mockup id, variant ids, camera position, and whether it is the default image). Mockups are generated by Printify and are read-only.",
      inputSchema: {
        shopId,
        productId: z.string(),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => actions.getProductMockups(client, args),
  );

  tool(
    "find_products",
    {
      title: "Find products by title or tag",
      description:
        "Scan the shop product list for an exact title and/or an exact tag (both case-insensitive). Printify has no title search parameter, so this pages through up to maxPages of 50. Use it before creating a product. If truncated is true, the scan did not reach the end of the catalog.",
      inputSchema: {
        shopId,
        title: z.string().optional().describe("Exact title match after trimming and collapsing whitespace."),
        tag: z.string().optional().describe("Tag that must be present on the product."),
        maxPages: z.number().int().min(1).max(40).optional().describe("Pages of 50 products to scan. Default 10."),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => actions.findProducts(client, args),
  );

  tool(
    "create_product_from_template",
    {
      title: "Create product from template",
      description:
        "Copy a product's blueprint, print provider, enabled variants, and prices into a new product, and replace one print position (default front) with an uploaded image. Position uses Printify's 0 to 1 coordinate system (0.5, 0.5 is the center). Scale 1 fills the placeholder width. Read-only fields from the template are not sent. By default, if a product with the same title (or idempotencyTag) already exists, nothing is created. There is no Printify collections API; Shopify collection names are only copied when they are already in sales_channel_properties.",
      inputSchema: {
        shopId,
        templateProductId: z.string().describe("Existing product to copy from."),
        title: z.string().describe("Title of the new product."),
        description: z.string().optional(),
        tags: z.array(z.string()).optional().describe("Replaces template tags when set."),
        idempotencyTag: z
          .string()
          .optional()
          .describe("Added to the new product's tags. When matchExisting is true, an existing product with this tag blocks creation."),
        matchExisting: z
          .boolean()
          .optional()
          .describe("Default true. Search by idempotencyTag, or by title when no tag is given, and skip create when a match exists."),
        maxPages: z.number().int().min(1).max(40).optional(),
        imageId: z.string().describe("Uploaded image id for the replaced position."),
        position: z
          .string()
          .optional()
          .describe("Placeholder position to replace. Default front. Use the exact catalog position, such as front_dtf."),
        x: z.number().optional().describe("Horizontal center of the artwork. Default keeps the template value, or 0.5."),
        y: z.number().optional().describe("Vertical center of the artwork. Default keeps the template value, or 0.5."),
        scale: z.number().positive().optional().describe("Width relative to the placeholder. 1 fills the width."),
        angle: z.number().optional().describe("Rotation in degrees. Sent as an integer."),
        variantIds: z
          .array(z.number().int())
          .optional()
          .describe("Template variant ids to enable. Default is every enabled template variant."),
        price: z.number().int().nonnegative().optional().describe("Override every copied variant price, in cents."),
        visible: z.boolean().optional(),
        copySalesChannelProperties: z
          .boolean()
          .optional()
          .describe("Default true. Copies sales_channel_properties when it is an object. This does not call a collections endpoint."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    (args) => actions.createProductFromTemplate(client, args),
  );

  tool(
    "create_product",
    {
      title: "Create product",
      description:
        "Create a product from writable fields only: title, blueprint_id, print_provider_id, variants (id, price in cents, is_enabled), and print_areas (variant_ids, placeholders with position and images of id, x, y, scale, angle). Do not send read-only fields. Prefer create_product_from_template when copying an existing product.",
      inputSchema: {
        shopId,
        title: z.string(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        blueprintId: z.number().int().positive(),
        printProviderId: z.number().int().positive(),
        variants: z
          .array(
            z.object({
              id: z.number().int(),
              price: z.number().int().nonnegative(),
              is_enabled: z.boolean().optional(),
              is_default: z.boolean().optional(),
            }),
          )
          .min(1),
        printAreas: z
          .array(
            z.object({
              variant_ids: z.array(z.number().int()).min(1),
              placeholders: z
                .array(
                  z.object({
                    position: z.string(),
                    images: z
                      .array(
                        z.object({
                          id: z.string(),
                          x: z.number(),
                          y: z.number(),
                          scale: z.number().positive(),
                          angle: z.number(),
                        }),
                      )
                      .min(1),
                  }),
                )
                .min(1),
            }),
          )
          .min(1),
        visible: z.boolean().optional(),
      },
    },
    (args) =>
      actions.createProduct(client, {
        shopId: args.shopId,
        product: {
          title: args.title,
          description: args.description,
          tags: args.tags,
          blueprint_id: args.blueprintId,
          print_provider_id: args.printProviderId,
          variants: args.variants.map((variant) => ({
            id: variant.id,
            price: variant.price,
            is_enabled: variant.is_enabled !== false,
            ...(variant.is_default ? { is_default: true } : {}),
          })),
          print_areas: args.printAreas,
          ...(args.visible !== undefined ? { visible: args.visible } : {}),
        },
      }),
  );

  tool(
    "update_product",
    {
      title: "Update product",
      description:
        "Update title, description, tags, visibility, safety information, print areas, or variants. Omitted fields stay unchanged. Print areas you send replace the stored print areas, with read-only image fields removed. When you send variants, include every variant; Printify rejects a partial variant list. Prices are integer cents.",
      inputSchema: {
        shopId,
        productId: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        visible: z.boolean().optional(),
        safetyInformation: z.string().max(1000).optional(),
        printAreas: z
          .array(
            z.object({
              variant_ids: z.array(z.number().int()).min(1),
              placeholders: z
                .array(
                  z.object({
                    position: z.string(),
                    images: z
                      .array(
                        z.object({
                          id: z.string(),
                          x: z.number(),
                          y: z.number(),
                          scale: z.number().positive(),
                          angle: z.number(),
                        }),
                      )
                      .min(1),
                  }),
                )
                .min(1),
            }),
          )
          .optional(),
        variants: z
          .array(
            z.object({
              id: z.number().int(),
              price: z.number().int().nonnegative(),
              is_enabled: z.boolean().optional(),
              is_default: z.boolean().optional(),
            }),
          )
          .optional()
          .describe("Full variant list. Partial lists are rejected by Printify."),
      },
    },
    (args) => actions.updateProduct(client, args),
  );

  tool(
    "publish_product",
    {
      title: "Publish product and wait for storefront URL",
      description:
        "POST /publish.json for a shop connected to a sales channel, then poll the product until external.handle is an absolute http(s) URL or the timeout elapses. The publish response itself is not success. This server never calls publishing_succeeded or publishing_failed. Disconnected shops and custom API shops often stay locked with no storefront URL; report that pending state instead of inventing a URL. If this times out, use get_publish_status rather than publishing again.",
      inputSchema: {
        shopId,
        productId: z.string(),
        title: z.boolean().optional().describe("Update the sales-channel title. Default true."),
        description: z.boolean().optional().describe("Update the sales-channel description. Default true."),
        images: z.boolean().optional().describe("Publish images. Default true."),
        variants: z.boolean().optional().describe("Publish variants. Default true."),
        tags: z.boolean().optional().describe("Publish tags. Default true."),
        keyFeatures: z.boolean().optional().describe("Sales channels that support key features. Omitted unless set."),
        shippingTemplate: z.boolean().optional().describe("Etsy and Amazon shipping template. Sent as shipping_template."),
        wait: z.boolean().optional().describe("Default true. When false, return after the publish POST without polling."),
        timeoutMs: z
          .number()
          .int()
          .optional()
          .describe("How long to poll. Default 45000. Use 0 for a single status check. Maximum 120000."),
        intervalMs: z.number().int().optional().describe("Delay between product reads. Default 3000. Minimum 1000."),
      },
    },
    (args) => actions.publishProduct(client, args),
  );

  tool(
    "get_publish_status",
    {
      title: "Get publish status",
      description:
        "Read whether a product has an external http(s) storefront URL. Does not publish and does not call publishing_succeeded. Use this to continue waiting after publish_product times out.",
      inputSchema: { shopId, productId: z.string() },
      annotations: { readOnlyHint: true },
    },
    (args) => actions.getPublishStatus(client, args),
  );

  tool(
    "unpublish_product",
    {
      title: "Unpublish product",
      description:
        "Notify Printify that a product was unpublished (POST /unpublish.json). Requires confirm true. Printify returns 400 when the product was not published.",
      inputSchema: {
        shopId,
        productId: z.string(),
        confirm: z.literal(true).describe("Must be true or the product is left unchanged."),
      },
      annotations: { destructiveHint: true, readOnlyHint: false },
    },
    (args) => actions.unpublishProduct(client, args),
  );

  tool(
    "delete_product",
    {
      title: "Delete product",
      description:
        "Permanently delete a product. Requires confirm true. Printify returns 409 when the product is still syncing from its sales channel.",
      inputSchema: {
        shopId,
        productId: z.string(),
        confirm: z.literal(true).describe("Must be true or the product is not deleted."),
      },
      annotations: { destructiveHint: true, readOnlyHint: false },
    },
    (args) => actions.deleteProduct(client, args),
  );

  tool(
    "upload_image",
    {
      title: "Upload image",
      description:
        "Upload artwork to the Printify media library by public URL, base64 contents, or a local file path. Provide exactly one source. URL upload is required for files larger than 5MB; base64 and local files over that size are refused. Supported artwork types are PNG and JPEG. The returned id is what print areas use.",
      inputSchema: {
        fileName: z.string().describe("File name stored in the media library, such as design.png."),
        url: z.string().optional().describe("Public http(s) image URL."),
        contents: z.string().optional().describe("Base64 image, with or without a data:image/...;base64, prefix."),
        filePath: z.string().optional().describe("Local file path to read and upload as base64."),
      },
    },
    (args) => actions.uploadImage(client, args),
  );

  tool(
    "list_uploads",
    {
      title: "List uploads",
      description: "List images in the Printify media library. Page size is at most 50. Default limit is 10.",
      inputSchema: {
        page: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => actions.listUploads(client, args),
  );

  tool(
    "get_upload",
    {
      title: "Get upload",
      description: "Get one media-library image by id, including preview_url, pixel size, and mime type.",
      inputSchema: { imageId: z.string() },
      annotations: { readOnlyHint: true },
    },
    (args) => actions.getUpload(client, args.imageId),
  );

  tool(
    "archive_upload",
    {
      title: "Archive upload",
      description: "Archive an image in the media library. Requires confirm true. Archived images are removed from the active library.",
      inputSchema: {
        imageId: z.string(),
        confirm: z.literal(true).describe("Must be true or the image is not archived."),
      },
      annotations: { destructiveHint: true },
    },
    (args) => actions.archiveUpload(client, args),
  );

  server.registerPrompt(
    "generate_product_description",
    {
      title: "Generate product description",
      description: "Ask the assistant for a sales-channel product description.",
      argsSchema: {
        productName: z.string(),
        category: z.string(),
        targetAudience: z.string().optional(),
        keyFeatures: z.string().optional().describe("Comma-separated features."),
      },
    },
    (args) => {
      const features = args.keyFeatures
        ? `\nKey features:\n${args.keyFeatures
            .split(",")
            .map((feature) => feature.trim())
            .filter(Boolean)
            .map((feature) => `- ${feature}`)
            .join("\n")}`
        : "";
      const audience = args.targetAudience ? `\nTarget audience: ${args.targetAudience}` : "";
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Write a product description for a print-on-demand listing.\n\nProduct name: ${args.productName}\nCategory: ${args.category}${audience}${features}\n\nBe specific, ready to paste into Printify, and do not invent materials or sizes that were not provided.`,
            },
          },
        ],
      };
    },
  );

  return server;
}
