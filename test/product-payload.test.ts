import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildProductFromTemplate, sanitizePrintAreas, sanitizeVariants } from "../dist/product-payload.js";
import type { PrintifyProduct } from "../dist/types.js";

function template(): PrintifyProduct {
  return {
    id: "prod_template",
    title: "Template Tee",
    description: "A template",
    safety_information: "Wash cold.",
    tags: ["tee"],
    options: [{ name: "Sizes" }],
    user_id: 5,
    shop_id: 9,
    created_at: "2020-01-01 00:00:00+00:00",
    updated_at: "2020-01-02 00:00:00+00:00",
    views: [{ id: 1 }],
    images: [{ src: "https://images.example/mockup.jpg", position: "front" }],
    external: { id: "ext", handle: "https://shop.example/products/old" },
    is_locked: false,
    visible: true,
    blueprint_id: 12,
    print_provider_id: 29,
    sales_channel_properties: [],
    print_details: [],
    variants: [
      { id: 10, price: 2499, is_enabled: true, is_default: true, sku: "OLD-10", cost: 800, grams: 120, title: "Black / S" },
      { id: 11, price: 2599.4, is_enabled: true, sku: "OLD-11", cost: 900, grams: 130, title: "Black / M" },
      { id: 12, price: 1999, is_enabled: false, sku: "OLD-12", title: "Black / L" },
    ],
    print_areas: [
      {
        variant_ids: [10, 11, 12],
        background: "#ffffff",
        placeholders: [
          {
            position: "front",
            decoration_method: "dtg",
            images: [
              {
                id: "old-front",
                src: "https://cdn.example/old.png",
                name: "old.png",
                type: "image/png",
                height: 1000,
                width: 1000,
                x: 0.4,
                y: 0.6,
                scale: 0.8,
                angle: 12.2,
              },
              { id: "text-layer", type: "text/svg", input_text: "Hello", x: 0.5, y: 0.5, scale: 1, angle: 0 },
            ],
          },
          {
            position: "back",
            decoration_method: "dtg",
            images: [{ id: "old-back", x: 0.5, y: 0.5, scale: 1, angle: 0, src: "https://cdn.example/back.png" }],
          },
        ],
      },
    ],
  };
}

describe("buildProductFromTemplate", () => {
  it("copies blueprint, provider, enabled variants, and prices, and replaces the front image", () => {
    const { body, warnings } = buildProductFromTemplate(template(), {
      title: "New Tee",
      artwork: { imageId: "new-art", position: "front", x: 0.5, y: 0.5, scale: 1.25, angle: 90 },
      idempotencyTag: "drop-42",
    });

    assert.equal(body.blueprint_id, 12);
    assert.equal(body.print_provider_id, 29);
    assert.deepEqual(
      body.variants.map((variant) => variant.id),
      [10, 11],
    );
    assert.equal(body.variants[0].price, 2499);
    assert.equal(body.variants[1].price, 2599);
    assert.equal(body.variants[0].is_default, true);
    assert.equal(body.variants[1].is_default, false);
    assert.equal(body.tags?.includes("drop-42"), true);
    assert.equal(body.tags?.includes("tee"), true);

    const front = body.print_areas[0].placeholders.find((placeholder) => placeholder.position === "front");
    const back = body.print_areas[0].placeholders.find((placeholder) => placeholder.position === "back");
    assert.deepEqual(front?.images, [{ id: "new-art", x: 0.5, y: 0.5, scale: 1.25, angle: 90 }]);
    assert.equal(back?.images[0].id, "old-back");
    assert.equal(body.print_areas[0].variant_ids.includes(12), false);
    assert.equal(warnings.some((warning) => warning.includes("text layer")), true);
    assert.equal(JSON.stringify(body).includes("decoration_method"), false);
    assert.equal(JSON.stringify(body).includes("old-front"), false);
    assert.equal("external" in body, false);
    assert.equal("images" in body, false);
    assert.equal("id" in body, false);
    assert.equal("sales_channel_properties" in body, false);
    assert.equal("print_details" in body, false);
    for (const variant of body.variants) {
      assert.equal("sku" in variant, false);
      assert.equal("cost" in variant, false);
      assert.equal("grams" in variant, false);
    }
  });

  it("keeps template placement when x, y, and scale are omitted", () => {
    const { body } = buildProductFromTemplate(template(), {
      title: "Placed",
      artwork: { imageId: "new-art" },
    });
    const front = body.print_areas[0].placeholders.find((placeholder) => placeholder.position === "front");
    assert.deepEqual(front?.images[0], { id: "new-art", x: 0.4, y: 0.6, scale: 0.8, angle: 12 });
  });

  it("adds a placeholder when the requested position is missing", () => {
    const { body, warnings } = buildProductFromTemplate(template(), {
      title: "Sleeve",
      artwork: { imageId: "sleeve-art", position: "left_sleeve" },
    });
    assert.equal(
      body.print_areas.some((area) => area.placeholders.some((placeholder) => placeholder.position === "left_sleeve")),
      true,
    );
    assert.equal(warnings.some((warning) => warning.includes("left_sleeve")), true);
  });

  it("copies sales channel properties and print details when they are objects", () => {
    const source = template();
    source.sales_channel_properties = { collections: ["Tees"], free_shipping: false };
    source.print_details = { print_on_side: "mirror", unknown: "nope" };
    const { body, warnings } = buildProductFromTemplate(source, {
      title: "Channel",
      artwork: { imageId: "img" },
    });
    assert.deepEqual(body.sales_channel_properties, { collections: ["Tees"], free_shipping: false });
    assert.deepEqual(body.print_details, { print_on_side: "mirror" });
    assert.equal(warnings.some((warning) => warning.includes("collections")), true);
  });
});

describe("sanitize update payloads", () => {
  it("drops read-only print area fields", () => {
    const areas = sanitizePrintAreas([
      {
        variant_ids: [10],
        background: "#fff",
        placeholders: [
          {
            position: "front",
            decoration_method: "dtg",
            images: [
              {
                id: "img",
                x: 0.2,
                y: 0.3,
                scale: 0.5,
                angle: 1.6,
                src: "https://cdn.example/x.png",
                name: "x.png",
                type: "image/png",
              },
            ],
          },
        ],
      },
    ]);
    assert.deepEqual(areas, [
      {
        variant_ids: [10],
        placeholders: [{ position: "front", images: [{ id: "img", x: 0.2, y: 0.3, scale: 0.5, angle: 2 }] }],
      },
    ]);
  });

  it("rejects more than one default variant", () => {
    assert.throws(
      () =>
        sanitizeVariants([
          { id: 1, price: 100, is_default: true },
          { id: 2, price: 100, is_default: true },
        ]),
      /Only one variant/,
    );
  });
});
