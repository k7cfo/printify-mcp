import { PrintifyInputError } from "./errors.js";
import type {
  PrintifyProduct,
  ProductPrintArea,
  WritablePrintArea,
  WritableProduct,
  WritableVariant,
} from "./types.js";

export interface TemplateArtwork {
  imageId: string;
  /** Catalog placeholder position. Exact match, for example "front" or "front_dtf". */
  position?: string;
  x?: number;
  y?: number;
  scale?: number;
  angle?: number;
}

export interface TemplateCreateOptions {
  title: string;
  description?: string;
  tags?: string[];
  /** Added to tags and used by the caller for idempotent lookup. */
  idempotencyTag?: string;
  artwork: TemplateArtwork;
  /** When set, only these template variant ids are copied. They are enabled. */
  variantIds?: number[];
  /** Integer cents applied to every copied variant. */
  price?: number;
  visible?: boolean;
  /** Default true. Shopify collection names live here; this is not a collections API. */
  copySalesChannelProperties?: boolean;
}

export interface TemplateBuildResult {
  body: WritableProduct;
  warnings: string[];
}

const PRINT_DETAIL_KEYS = ["print_on_side", "separator_type", "separator_color"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function roundPrice(price: number, warnings: string[], variantId: number): number {
  if (!Number.isFinite(price)) {
    throw new PrintifyInputError(`Variant ${variantId} has no finite price on the template.`);
  }
  const rounded = Math.round(price);
  if (rounded !== price) {
    warnings.push(`Rounded variant ${variantId} price from ${price} to ${rounded} cents.`);
  }
  if (rounded < 0) {
    throw new PrintifyInputError(`Variant ${variantId} price must be zero or a positive number of cents.`);
  }
  return rounded;
}

function writableImage(
  imageId: string,
  x: number,
  y: number,
  scale: number,
  angle: number,
): WritableProduct["print_areas"][number]["placeholders"][number]["images"][number] {
  if (!imageId.trim()) {
    throw new PrintifyInputError("Artwork image id is empty.");
  }
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scale) || !Number.isFinite(angle)) {
    throw new PrintifyInputError("Artwork x, y, scale, and angle must be finite numbers.");
  }
  if (scale <= 0) {
    throw new PrintifyInputError("Artwork scale must be greater than 0. Scale 1 fills the placeholder width.");
  }
  return {
    id: imageId,
    x,
    y,
    scale,
    angle: Math.round(angle),
  };
}

function layerIsText(layer: { input_text?: string; type?: string }): boolean {
  return Boolean(layer.input_text) || layer.type === "text/svg";
}

function addTag(tags: string[], tag: string): string[] {
  if (tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) {
    return tags;
  }
  return [...tags, tag];
}

/**
 * Build a create-product body from a product used as a template.
 * Only writable fields are copied. Read-only product, variant, placeholder,
 * and image fields returned by GET product are dropped on purpose.
 */
export function buildProductFromTemplate(
  template: PrintifyProduct,
  options: TemplateCreateOptions,
): TemplateBuildResult {
  const warnings: string[] = [];
  if (!options.title.trim()) {
    throw new PrintifyInputError("A product title is required.");
  }
  if (!Number.isInteger(template.blueprint_id) || !Number.isInteger(template.print_provider_id)) {
    throw new PrintifyInputError("Template product is missing blueprint_id or print_provider_id.");
  }

  const knownIds = new Set((template.variants ?? []).map((variant) => variant.id));
  let selected = template.variants ?? [];
  if (options.variantIds) {
    const missing = options.variantIds.filter((id) => !knownIds.has(id));
    if (missing.length > 0) {
      throw new PrintifyInputError(
        `Variant ids are not on the template product: ${missing.join(", ")}.`,
      );
    }
    const wanted = new Set(options.variantIds);
    selected = selected.filter((variant) => wanted.has(variant.id));
    const disabled = selected.filter((variant) => variant.is_enabled === false).map((variant) => variant.id);
    if (disabled.length > 0) {
      warnings.push(
        `Enabling template variants that were disabled, because they were requested explicitly: ${disabled.join(", ")}.`,
      );
    }
  } else {
    selected = selected.filter((variant) => variant.is_enabled !== false);
  }
  if (selected.length === 0) {
    throw new PrintifyInputError(
      "The template has no enabled variants to copy. Pass variantIds to choose variants explicitly.",
    );
  }

  const defaultId = selected.find((variant) => variant.is_default)?.id ?? selected[0].id;
  const priceOverride = options.price;
  if (priceOverride !== undefined && (!Number.isInteger(priceOverride) || priceOverride < 0)) {
    throw new PrintifyInputError("price must be an integer number of cents, zero or greater.");
  }

  const variants: WritableVariant[] = selected.map((variant) => ({
    id: variant.id,
    price: priceOverride ?? roundPrice(variant.price, warnings, variant.id),
    is_enabled: true,
    is_default: variant.id === defaultId,
  }));
  const variantIds = variants.map((variant) => variant.id);
  const variantIdSet = new Set(variantIds);

  const position = options.artwork.position ?? "front";
  let replaced = false;
  const printAreas: WritablePrintArea[] = [];

  for (const area of template.print_areas ?? []) {
    const areaVariantIds = (area.variant_ids ?? []).filter((id) => variantIdSet.has(id));
    if (areaVariantIds.length === 0) {
      continue;
    }
    const placeholders: WritablePrintArea["placeholders"] = [];
    for (const placeholder of area.placeholders ?? []) {
      const layers = placeholder.images ?? [];
      const textCount = layers.filter((layer) => layerIsText(layer)).length;
      if (textCount > 0) {
        warnings.push(
          `Dropped ${textCount} text layer(s) on position "${placeholder.position}". Text styling is read-only and is not sent on create.`,
        );
      }
      if (placeholder.position === position) {
        const sample = layers.find((layer) => !layerIsText(layer) && layer.id);
        placeholders.push({
          position,
          images: [
            writableImage(
              options.artwork.imageId,
              options.artwork.x ?? sample?.x ?? 0.5,
              options.artwork.y ?? sample?.y ?? 0.5,
              options.artwork.scale ?? sample?.scale ?? 1,
              options.artwork.angle ?? sample?.angle ?? 0,
            ),
          ],
        });
        replaced = true;
        continue;
      }
      const images = layers
        .filter((layer) => !layerIsText(layer) && layer.id)
        .map((layer) =>
          writableImage(
            String(layer.id),
            layer.x ?? 0.5,
            layer.y ?? 0.5,
            layer.scale ?? 1,
            layer.angle ?? 0,
          ),
        );
      if (images.length === 0) {
        continue;
      }
      placeholders.push({ position: placeholder.position, images });
    }
    if (placeholders.length === 0) {
      continue;
    }
    printAreas.push({ variant_ids: areaVariantIds, placeholders });
  }

  if (!replaced) {
    warnings.push(
      `Template has no "${position}" placeholder. Added one covering the copied variants. Check catalog variant placeholders for the real position name.`,
    );
    const image = writableImage(
      options.artwork.imageId,
      options.artwork.x ?? 0.5,
      options.artwork.y ?? 0.5,
      options.artwork.scale ?? 1,
      options.artwork.angle ?? 0,
    );
    if (printAreas.length === 0) {
      printAreas.push({
        variant_ids: variantIds,
        placeholders: [{ position, images: [image] }],
      });
    } else {
      printAreas[0].placeholders.push({ position, images: [image] });
    }
  }

  let tags = options.tags ? [...options.tags] : [...(template.tags ?? [])];
  if (options.idempotencyTag) {
    tags = addTag(tags, options.idempotencyTag);
  }

  const body: WritableProduct = {
    title: options.title,
    blueprint_id: template.blueprint_id,
    print_provider_id: template.print_provider_id,
    variants,
    print_areas: printAreas,
  };
  if (options.description !== undefined) {
    body.description = options.description;
  } else if (template.description !== undefined) {
    body.description = template.description;
  }
  if (tags.length > 0) {
    body.tags = tags;
  }
  if (template.safety_information) {
    if (template.safety_information.length > 1000) {
      warnings.push("Dropped safety_information because Printify limits it to 1000 characters.");
    } else {
      body.safety_information = template.safety_information;
    }
  }
  if (typeof options.visible === "boolean") {
    body.visible = options.visible;
  } else if (typeof template.visible === "boolean") {
    body.visible = template.visible;
  }

  const details = template.print_details;
  if (isPlainObject(details)) {
    const copy: NonNullable<WritableProduct["print_details"]> = {};
    for (const key of PRINT_DETAIL_KEYS) {
      const value = details[key];
      if (typeof value === "string" && value) {
        copy[key] = value;
      }
    }
    if (Object.keys(copy).length > 0) {
      body.print_details = copy;
    }
  }

  if (options.copySalesChannelProperties !== false && isPlainObject(template.sales_channel_properties)) {
    const entries = Object.entries(template.sales_channel_properties);
    if (entries.length > 0) {
      body.sales_channel_properties = Object.fromEntries(entries);
      warnings.push(
        "Copied sales_channel_properties from the template. Shopify collection names are a sales-channel property on the product. Printify has no public collections resource.",
      );
    }
  }

  return { body, warnings };
}

/** Keep only fields Printify accepts when replacing print areas. */
export function sanitizePrintAreas(areas: ProductPrintArea[]): WritablePrintArea[] {
  if (!Array.isArray(areas) || areas.length === 0) {
    throw new PrintifyInputError("printAreas must be a non-empty array.");
  }
  return areas.map((area, areaIndex) => {
    if (!Array.isArray(area.variant_ids) || area.variant_ids.length === 0) {
      throw new PrintifyInputError(`printAreas[${areaIndex}] needs at least one variant id.`);
    }
    const placeholders = (area.placeholders ?? []).map((placeholder, placeholderIndex) => {
      if (!placeholder.position) {
        throw new PrintifyInputError(
          `printAreas[${areaIndex}].placeholders[${placeholderIndex}] needs a position.`,
        );
      }
      const images = (placeholder.images ?? []).filter((image) => image.id && !layerIsText(image));
      if (images.length === 0) {
        throw new PrintifyInputError(
          `printAreas[${areaIndex}] position "${placeholder.position}" needs at least one image with an id.`,
        );
      }
      return {
        position: placeholder.position,
        images: images.map((image) =>
          writableImage(String(image.id), image.x ?? 0.5, image.y ?? 0.5, image.scale ?? 1, image.angle ?? 0),
        ),
      };
    });
    if (placeholders.length === 0) {
      throw new PrintifyInputError(`printAreas[${areaIndex}] needs at least one placeholder.`);
    }
    return { variant_ids: area.variant_ids, placeholders };
  });
}

/** Keep only writable variant fields. Every variant must include id and price. */
export function sanitizeVariants(
  variants: Array<{ id: number; price: number; is_enabled?: boolean; is_default?: boolean }>,
): WritableVariant[] {
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new PrintifyInputError(
      "variants must list every variant. Printify requires the full variant list when variants are updated.",
    );
  }
  let defaults = 0;
  const sanitized = variants.map((variant) => {
    if (!Number.isInteger(variant.id)) {
      throw new PrintifyInputError("Each variant needs an integer id.");
    }
    if (!Number.isInteger(variant.price) || variant.price < 0) {
      throw new PrintifyInputError(`Variant ${variant.id} price must be an integer number of cents.`);
    }
    if (variant.is_default) {
      defaults += 1;
    }
    return {
      id: variant.id,
      price: variant.price,
      is_enabled: variant.is_enabled !== false,
      ...(variant.is_default ? { is_default: true } : {}),
    };
  });
  if (defaults > 1) {
    throw new PrintifyInputError("Only one variant can be marked is_default.");
  }
  return sanitized;
}
