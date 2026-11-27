import { PrintifyInputError } from "./errors.js";
import { PrintifyClient, storefrontUrlFromExternal } from "./client.js";
import {
  buildProductFromTemplate,
  sanitizePrintAreas,
  sanitizeVariants,
} from "./product-payload.js";
import type {
  CatalogBlueprint,
  CatalogVariant,
  PrintifyProduct,
  ProductPrintArea,
  WritableProduct,
} from "./types.js";

function requireInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new PrintifyInputError(`${label} must be a positive integer.`);
  }
  return value;
}

function summarizeProduct(product: PrintifyProduct) {
  const enabled = (product.variants ?? []).filter((variant) => variant.is_enabled !== false);
  const prices = enabled.map((variant) => variant.price).filter((price) => typeof price === "number");
  return {
    id: product.id,
    title: product.title,
    tags: product.tags ?? [],
    blueprint_id: product.blueprint_id,
    print_provider_id: product.print_provider_id,
    visible: product.visible ?? null,
    is_locked: product.is_locked ?? null,
    external: product.external ?? null,
    storefrontUrl: storefrontUrlFromExternal(product.external),
    updated_at: product.updated_at ?? null,
    enabled_variant_count: enabled.length,
    price_min: prices.length > 0 ? Math.min(...prices) : null,
    price_max: prices.length > 0 ? Math.max(...prices) : null,
  };
}

export async function listShops(client: PrintifyClient) {
  const shops = await client.listShops();
  return {
    shops: shops.map((shop) => ({
      id: shop.id,
      title: shop.title,
      sales_channel: shop.sales_channel,
      configured: client.defaultShopId === shop.id,
    })),
  };
}

export async function verifyShop(
  client: PrintifyClient,
  input: { shopId?: number; title?: string },
) {
  return client.verifyShop({ id: input.shopId, title: input.title });
}

export async function listBlueprints(
  client: PrintifyClient,
  input: { search?: string; limit?: number },
) {
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new PrintifyInputError("limit must be an integer from 1 to 200. The catalog endpoint itself is not paginated.");
  }
  const all = await client.listBlueprints();
  const search = input.search?.trim().toLowerCase();
  const filtered = search
    ? all.filter((blueprint) =>
        [blueprint.title, blueprint.brand, blueprint.model]
          .filter((part): part is string => Boolean(part))
          .some((part) => part.toLowerCase().includes(search)),
      )
    : all;
  return {
    total: all.length,
    matched: filtered.length,
    returned: Math.min(limit, filtered.length),
    truncated: filtered.length > limit,
    note: "GET /v1/catalog/blueprints.json returns the full catalog in one response. search and limit are applied locally. tags, features, and care instructions are only on get_blueprint.",
    blueprints: filtered.slice(0, limit).map((blueprint: CatalogBlueprint) => ({
      id: blueprint.id,
      title: blueprint.title,
      brand: blueprint.brand ?? null,
      model: blueprint.model ?? null,
    })),
  };
}

export async function getBlueprint(client: PrintifyClient, blueprintId: number) {
  return client.getBlueprint(requireInteger(blueprintId, "blueprintId"));
}

export async function getBlueprintSizeGuide(client: PrintifyClient, blueprintId: number) {
  return client.getBlueprintSizeGuide(requireInteger(blueprintId, "blueprintId"));
}

export async function listPrintProviders(client: PrintifyClient) {
  return client.listPrintProviders();
}

export async function getPrintProvider(client: PrintifyClient, printProviderId: number) {
  return client.getPrintProvider(requireInteger(printProviderId, "printProviderId"));
}

export async function listBlueprintPrintProviders(client: PrintifyClient, blueprintId: number) {
  return client.listBlueprintPrintProviders(requireInteger(blueprintId, "blueprintId"));
}

export async function getBlueprintVariants(
  client: PrintifyClient,
  input: { blueprintId: number; printProviderId: number; showOutOfStock?: boolean; size?: string; color?: string },
) {
  const payload = await client.listBlueprintVariants(
    requireInteger(input.blueprintId, "blueprintId"),
    requireInteger(input.printProviderId, "printProviderId"),
    input.showOutOfStock ?? false,
  );
  const record = payload as { id?: number; title?: string; variants?: CatalogVariant[] };
  let variants = record.variants ?? [];
  if (input.size) {
    const size = input.size.toLowerCase();
    variants = variants.filter((variant) => (variant.options?.size ?? "").toLowerCase() === size);
  }
  if (input.color) {
    const color = input.color.toLowerCase();
    variants = variants.filter((variant) => (variant.options?.color ?? "").toLowerCase() === color);
  }
  return {
    id: record.id ?? input.printProviderId,
    title: record.title ?? null,
    variant_count: variants.length,
    note: "Each variant placeholder has width and height in pixels and a decoration_method. Choose a position from that list when placing artwork. decoration_method cannot be set on create; the position selects it. Without showOutOfStock, Printify returns only in-stock variants.",
    variants,
  };
}

export async function getBlueprintShipping(
  client: PrintifyClient,
  blueprintId: number,
  printProviderId: number,
) {
  return client.getBlueprintShipping(
    requireInteger(blueprintId, "blueprintId"),
    requireInteger(printProviderId, "printProviderId"),
  );
}

export async function listProducts(
  client: PrintifyClient,
  input: { shopId?: number; page?: number; limit?: number },
) {
  const { shop } = await client.resolveShopId(input.shopId);
  const page = await client.listProducts(shop.id, input.page, input.limit);
  return {
    shop,
    current_page: page.current_page ?? input.page ?? 1,
    last_page: page.last_page ?? null,
    total: page.total ?? null,
    per_page: page.per_page ?? null,
    note: "Summaries only. get_product returns print areas, variant prices, and mockup image URLs. Product list limit is at most 50.",
    products: (page.data ?? []).map(summarizeProduct),
  };
}

export async function getProduct(client: PrintifyClient, input: { shopId?: number; productId: string }) {
  const { shop } = await client.resolveShopId(input.shopId);
  const product = await client.getProduct(shop.id, input.productId);
  return { shop, product };
}

export async function getProductMockups(client: PrintifyClient, input: { shopId?: number; productId: string }) {
  const { shop } = await client.resolveShopId(input.shopId);
  const product = await client.getProduct(shop.id, input.productId);
  const mockups = (product.images ?? [])
    .filter((image) => image.src)
    .map((image) => ({
      src: image.src,
      mockup_id: image.mockup_id ?? null,
      variant_ids: image.variant_ids ?? [],
      position: image.position ?? null,
      is_default: image.is_default ?? false,
    }));
  return {
    shop,
    productId: product.id,
    title: product.title,
    mockup_count: mockups.length,
    mockups,
  };
}

export async function findProducts(
  client: PrintifyClient,
  input: { shopId?: number; title?: string; tag?: string; maxPages?: number },
) {
  const { shop } = await client.resolveShopId(input.shopId);
  const found = await client.findProducts(shop.id, input);
  return {
    shop,
    pagesScanned: found.pagesScanned,
    truncated: found.truncated,
    total: found.total,
    matchCount: found.matches.length,
    note: found.truncated
      ? "The search stopped early. Raise maxPages before treating this as proof a product does not exist."
      : "The Printify product list has no title or tag filter, so this scans pages of up to 50 products.",
    matches: found.matches.map(summarizeProduct),
  };
}

export async function createProduct(
  client: PrintifyClient,
  input: { shopId?: number; product: WritableProduct },
) {
  const { shop } = await client.resolveShopId(input.shopId);
  const product = await client.createProduct(shop.id, input.product);
  return { shop, product: summarizeProduct(product), id: product.id };
}

export async function createProductFromTemplate(
  client: PrintifyClient,
  input: {
    shopId?: number;
    templateProductId: string;
    title: string;
    description?: string;
    tags?: string[];
    idempotencyTag?: string;
    matchExisting?: boolean;
    imageId: string;
    position?: string;
    x?: number;
    y?: number;
    scale?: number;
    angle?: number;
    variantIds?: number[];
    price?: number;
    visible?: boolean;
    copySalesChannelProperties?: boolean;
    maxPages?: number;
  },
) {
  const { shop } = await client.resolveShopId(input.shopId);
  const matchExisting = input.matchExisting !== false;
  if (matchExisting) {
    const found = await client.findProducts(shop.id, {
      title: input.idempotencyTag ? undefined : input.title,
      tag: input.idempotencyTag,
      maxPages: input.maxPages,
    });
    if (found.truncated && found.matches.length === 0) {
      throw new PrintifyInputError(
        `Looked through ${found.pagesScanned} pages and Printify still has more products. No create was sent. Raise maxPages or pass idempotencyTag so an existing product is not missed.`,
      );
    }
    if (found.matches.length > 0) {
      return {
        created: false,
        shop,
        message: input.idempotencyTag
          ? `A product already has tag "${input.idempotencyTag}". Nothing was created.`
          : `A product titled "${input.title}" already exists. Nothing was created.`,
        matches: found.matches.map(summarizeProduct),
      };
    }
  }

  const template = await client.getProduct(shop.id, input.templateProductId);
  const built = buildProductFromTemplate(template, {
    title: input.title,
    description: input.description,
    tags: input.tags,
    idempotencyTag: input.idempotencyTag,
    artwork: {
      imageId: input.imageId,
      position: input.position,
      x: input.x,
      y: input.y,
      scale: input.scale,
      angle: input.angle,
    },
    variantIds: input.variantIds,
    price: input.price,
    visible: input.visible,
    copySalesChannelProperties: input.copySalesChannelProperties,
  });
  const product = await client.createProduct(shop.id, built.body);
  return {
    created: true,
    shop,
    warnings: built.warnings,
    sent: built.body,
    product,
  };
}

export async function updateProduct(
  client: PrintifyClient,
  input: {
    shopId?: number;
    productId: string;
    title?: string;
    description?: string;
    tags?: string[];
    visible?: boolean;
    safetyInformation?: string;
    printAreas?: ProductPrintArea[];
    variants?: Array<{ id: number; price: number; is_enabled?: boolean; is_default?: boolean }>;
  },
) {
  const body: Record<string, unknown> = {};
  if (input.title !== undefined) {
    body.title = input.title;
  }
  if (input.description !== undefined) {
    body.description = input.description;
  }
  if (input.tags !== undefined) {
    body.tags = input.tags;
  }
  if (input.visible !== undefined) {
    body.visible = input.visible;
  }
  if (input.safetyInformation !== undefined) {
    if (input.safetyInformation.length > 1000) {
      throw new PrintifyInputError("safetyInformation must be 1000 characters or fewer.");
    }
    body.safety_information = input.safetyInformation;
  }
  if (input.printAreas !== undefined) {
    body.print_areas = sanitizePrintAreas(input.printAreas);
  }
  if (input.variants !== undefined) {
    body.variants = sanitizeVariants(input.variants);
  }
  if (Object.keys(body).length === 0) {
    throw new PrintifyInputError(
      "Update needs at least one of title, description, tags, visible, safetyInformation, printAreas, or variants.",
    );
  }
  const { shop } = await client.resolveShopId(input.shopId);
  const product = await client.updateProduct(shop.id, input.productId, body);
  return {
    shop,
    sent: body,
    note: "Read-only fields such as mockup images, decoration_method, and image src are not sent. When variants are included, Printify requires every variant.",
    product,
  };
}

function publishBody(input: {
  title?: boolean;
  description?: boolean;
  images?: boolean;
  variants?: boolean;
  tags?: boolean;
  keyFeatures?: boolean;
  shippingTemplate?: boolean;
}): Record<string, boolean> {
  const body: Record<string, boolean> = {
    title: input.title ?? true,
    description: input.description ?? true,
    images: input.images ?? true,
    variants: input.variants ?? true,
    tags: input.tags ?? true,
  };
  if (input.keyFeatures !== undefined) {
    body.keyFeatures = input.keyFeatures;
  }
  if (input.shippingTemplate !== undefined) {
    body.shipping_template = input.shippingTemplate;
  }
  return body;
}

export async function publishProduct(
  client: PrintifyClient,
  input: {
    shopId?: number;
    productId: string;
    title?: boolean;
    description?: boolean;
    images?: boolean;
    variants?: boolean;
    tags?: boolean;
    keyFeatures?: boolean;
    shippingTemplate?: boolean;
    wait?: boolean;
    timeoutMs?: number;
    intervalMs?: number;
  },
) {
  const timeoutMs = input.timeoutMs ?? 45_000;
  const intervalMs = input.intervalMs ?? 3_000;
  if (timeoutMs !== 0 && (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000)) {
    throw new PrintifyInputError("timeoutMs must be 0 (one status check) or an integer from 1000 to 120000.");
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 30_000) {
    throw new PrintifyInputError("intervalMs must be an integer from 1000 to 30000.");
  }
  const { shop } = await client.resolveShopId(input.shopId);
  const body = publishBody(input);
  if (input.wait === false) {
    await client.publishProduct(shop.id, input.productId, body);
    return {
      shop,
      publishRequested: true,
      published: false,
      storefrontUrl: null,
      message:
        "Publish was requested and this call did not wait. Success is an external http(s) storefront URL from get_publish_status, not this response. publishing_succeeded is never called.",
    };
  }
  const result = await client.publishAndWait(shop.id, input.productId, body, { timeoutMs, intervalMs });
  return { shop, sales_channel: shop.sales_channel, ...result };
}

export async function getPublishStatus(client: PrintifyClient, input: { shopId?: number; productId: string }) {
  const { shop } = await client.resolveShopId(input.shopId);
  const product = await client.getProduct(shop.id, input.productId);
  const storefrontUrl = storefrontUrlFromExternal(product.external);
  return {
    shop,
    productId: product.id,
    published: Boolean(storefrontUrl),
    storefrontUrl,
    external: product.external ?? null,
    is_locked: product.is_locked ?? null,
    message: storefrontUrl
      ? "The product has an external storefront URL."
      : "No absolute http(s) storefront URL is on external.handle yet. This check does not publish and does not call publishing_succeeded.",
  };
}

export async function unpublishProduct(
  client: PrintifyClient,
  input: { shopId?: number; productId: string; confirm: true },
) {
  if (input.confirm !== true) {
    throw new PrintifyInputError("unpublish_product requires confirm: true.");
  }
  const { shop } = await client.resolveShopId(input.shopId);
  await client.unpublishProduct(shop.id, input.productId);
  return {
    shop,
    productId: input.productId,
    unpublished: true,
    message: "Printify accepted the unpublish notification.",
  };
}

export async function deleteProduct(
  client: PrintifyClient,
  input: { shopId?: number; productId: string; confirm: true },
) {
  if (input.confirm !== true) {
    throw new PrintifyInputError("delete_product requires confirm: true.");
  }
  const { shop } = await client.resolveShopId(input.shopId);
  await client.deleteProduct(shop.id, input.productId);
  return {
    shop,
    productId: input.productId,
    deleted: true,
  };
}

export async function uploadImage(
  client: PrintifyClient,
  input: { fileName: string; url?: string; contents?: string; filePath?: string },
) {
  const image = await client.uploadImage(input);
  return { image };
}

export async function listUploads(client: PrintifyClient, input: { page?: number; limit?: number }) {
  const page = await client.listUploads(input.page, input.limit);
  return {
    current_page: page.current_page ?? input.page ?? 1,
    last_page: page.last_page ?? null,
    total: page.total ?? null,
    per_page: page.per_page ?? null,
    uploads: page.data ?? [],
  };
}

export async function getUpload(client: PrintifyClient, imageId: string) {
  return client.getUpload(imageId);
}

export async function archiveUpload(client: PrintifyClient, input: { imageId: string; confirm: true }) {
  if (input.confirm !== true) {
    throw new PrintifyInputError("archive_upload requires confirm: true.");
  }
  await client.archiveUpload(input.imageId);
  return { imageId: input.imageId, archived: true };
}
