import { readFile } from "node:fs/promises";
import { PrintifyApiError, PrintifyConfigError, PrintifyInputError, redactSecrets } from "./errors.js";
import type {
  CatalogBlueprint,
  PrintifyProduct,
  PrintifyShop,
  ProductExternal,
  ProductPage,
  PublishPollResult,
  UploadImage,
  UploadPage,
  WritableProduct,
} from "./types.js";
import { USER_AGENT } from "./version.js";

const DEFAULT_BASE_URL = "https://api.printify.com/v1/";
const MAX_PRODUCT_LIMIT = 50;
const MAX_UPLOAD_LIMIT = 50;
const DEFAULT_BASE64_BYTES = 5 * 1024 * 1024;

export interface PrintifyClientOptions {
  token: string;
  baseUrl?: string;
  defaultShopId?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: (message: string) => void;
  maxRetries?: number;
  /** Cap for Retry-After and exponential backoff. */
  maxRetryWaitMs?: number;
  baseDelayMs?: number;
  /** Refuse base64 and local-file uploads larger than this many decoded bytes. */
  maxBase64Bytes?: number;
}

export interface FindProductsQuery {
  title?: string;
  tag?: string;
  maxPages?: number;
}

export interface FindProductsResult {
  matches: PrintifyProduct[];
  pagesScanned: number;
  truncated: boolean;
  total: number | null;
}

/**
 * Read PRINTIFY_API_TOKEN from the environment.
 * The value is not accepted from tool arguments and must not be logged.
 */
export function tokenFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const token = env.PRINTIFY_API_TOKEN?.trim();
  if (!token) {
    const legacy = env.PRINTIFY_API_KEY?.trim();
    const hint = legacy
      ? " PRINTIFY_API_KEY is set but ignored; rename it to PRINTIFY_API_TOKEN."
      : "";
    throw new PrintifyConfigError(
      "PRINTIFY_API_TOKEN is not set." +
        hint +
        " Create a personal access token under Printify → My Profile → Connections and provide it only as an environment variable.",
    );
  }
  return token;
}

export function shopIdFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.PRINTIFY_SHOP_ID?.trim();
  if (!raw) {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    throw new PrintifyConfigError("PRINTIFY_SHOP_ID must be the numeric shop id from list_shops.");
  }
  return Number(raw);
}

export function assertPathSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new PrintifyInputError(`${label} must be a single id (letters, numbers, underscore, or hyphen).`);
  }
  return value;
}

export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Absolute http(s) URL only. Relative handles are not treated as a storefront URL. */
export function storefrontUrlFromExternal(external: ProductExternal | null | undefined): string | null {
  const handle = external?.handle;
  if (typeof handle !== "string") {
    return null;
  }
  const trimmed = handle.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function pageLimit(limit: number | undefined, max: number, fallback: number): number {
  const value = limit ?? fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new PrintifyInputError(`limit must be an integer from 1 to ${max}.`);
  }
  return value;
}

function pageNumber(page: number | undefined): number {
  const value = page ?? 1;
  if (!Number.isInteger(value) || value < 1) {
    throw new PrintifyInputError("page must be an integer of 1 or greater.");
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function errorCode(body: unknown): number | string | undefined {
  const record = asRecord(body);
  if (!record) {
    return undefined;
  }
  if (typeof record.code === "number" || typeof record.code === "string") {
    return record.code;
  }
  const errors = asRecord(record.errors);
  if (errors && (typeof errors.code === "number" || typeof errors.code === "string")) {
    return errors.code;
  }
  return undefined;
}

function errorReason(body: unknown): string | undefined {
  const record = asRecord(body);
  if (!record) {
    return undefined;
  }
  const errors = record.errors;
  if (typeof errors === "string" && errors.trim()) {
    return errors.trim();
  }
  const errorRecord = asRecord(errors);
  if (errorRecord && typeof errorRecord.reason === "string" && errorRecord.reason.trim()) {
    return errorRecord.reason.trim();
  }
  if (typeof record.error === "string" && record.error.trim()) {
    return record.error.trim();
  }
  if (typeof record.message === "string" && record.message.trim()) {
    return record.message.trim();
  }
  if (typeof record.title === "string" && record.title.trim()) {
    return record.title.trim();
  }
  return undefined;
}

function retryAfterMs(header: string | null, now: number): number | undefined {
  if (!header) {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const when = Date.parse(header);
  if (Number.isFinite(when)) {
    return Math.max(0, when - now);
  }
  return undefined;
}

function idempotentMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "PUT" || method === "DELETE";
}

/**
 * HTTP client for the Printify REST API.
 * The token is kept in a private field, omitted from JSON, and scrubbed from errors and logs.
 */
export class PrintifyClient {
  readonly #token: string;
  readonly baseUrl: string;
  readonly defaultShopId?: number;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #logger: (message: string) => void;
  readonly #maxRetries: number;
  readonly #maxRetryWaitMs: number;
  readonly #baseDelayMs: number;
  readonly #maxBase64Bytes: number;

  constructor(options: PrintifyClientOptions) {
    if (!options.token.trim()) {
      throw new PrintifyConfigError("PrintifyClient requires a non-empty token from PRINTIFY_API_TOKEN.");
    }
    this.#token = options.token.trim();
    const base = options.baseUrl ?? DEFAULT_BASE_URL;
    this.baseUrl = base.endsWith("/") ? base : `${base}/`;
    this.defaultShopId = options.defaultShopId;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? (() => Date.now());
    this.#logger = options.logger ?? ((message) => console.error(message));
    this.#maxRetries = options.maxRetries ?? 3;
    this.#maxRetryWaitMs = options.maxRetryWaitMs ?? 60_000;
    this.#baseDelayMs = options.baseDelayMs ?? 500;
    this.#maxBase64Bytes = options.maxBase64Bytes ?? DEFAULT_BASE64_BYTES;
  }

  toJSON(): { name: string; token: string; baseUrl: string; defaultShopId?: number } {
    return {
      name: "PrintifyClient",
      token: "[redacted]",
      baseUrl: this.baseUrl,
      defaultShopId: this.defaultShopId,
    };
  }

  redact(text: string): string {
    return redactSecrets(text, [this.#token]);
  }

  async request<T>(
    method: string,
    path: string,
    options: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<T> {
    if (path.includes("publishing_succeeded") || path.includes("publishing_failed")) {
      throw new PrintifyInputError(
        "Refusing to call publishing_succeeded or publishing_failed. Those endpoints mark a publish finished without a storefront confirming it. Poll the product until external.handle is an absolute http(s) URL.",
      );
    }
    const url = new URL(path.replace(/^\//, ""), this.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#token}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json;charset=utf-8";
      body = JSON.stringify(options.body);
    }

    const logPath = `${url.pathname}${url.search}`;
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method,
          headers,
          body,
          cache: "no-store",
          signal: AbortSignal.timeout(60_000),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (attempt < this.#maxRetries && idempotentMethod(method)) {
          const delay = this.#backoff(attempt);
          this.#log(`Network error on ${method} ${logPath}. Retry ${attempt + 1} in ${delay}ms.`);
          await this.#sleep(delay);
          continue;
        }
        const hint = idempotentMethod(method)
          ? "The request failed before Printify responded."
          : "The POST failed before Printify responded and was not retried, because retrying a POST can duplicate a product, upload, or publish. Check the shop before trying again.";
        throw new PrintifyApiError(this.redact(`${hint} ${reason}`), {
          method,
          path: logPath,
          retryable: false,
        });
      }

      const raw = await response.text();
      if (response.ok) {
        if (response.status === 204 || raw.length === 0) {
          return undefined as T;
        }
        try {
          return JSON.parse(raw) as T;
        } catch {
          throw new PrintifyApiError(`Printify ${method} ${logPath} returned a response that is not JSON.`, {
            status: response.status,
            method,
            path: logPath,
          });
        }
      }

      if (attempt < this.#maxRetries && this.#shouldRetry(method, response.status)) {
        const headerDelay = retryAfterMs(response.headers.get("retry-after"), this.#now());
        const delay = Math.min(this.#maxRetryWaitMs, headerDelay ?? this.#backoff(attempt));
        this.#log(`${response.status} on ${method} ${logPath}. Retry ${attempt + 1} in ${delay}ms.`);
        await this.#sleep(delay);
        continue;
      }

      throw this.#errorFromBody(method, logPath, response.status, raw);
    }
  }

  async listShops(): Promise<PrintifyShop[]> {
    const shops = await this.request<unknown>("GET", "shops.json");
    if (!Array.isArray(shops)) {
      throw new PrintifyApiError("Printify GET /v1/shops.json did not return a shop array.", {
        method: "GET",
        path: "/v1/shops.json",
      });
    }
    return shops as PrintifyShop[];
  }

  /**
   * Resolve the shop for a call and confirm it belongs to this account.
   * An explicit id or PRINTIFY_SHOP_ID is checked against the live shop list.
   * With neither, the account must contain exactly one shop.
   */
  async resolveShopId(explicit?: number): Promise<{ shop: PrintifyShop; shops: PrintifyShop[] }> {
    const shops = await this.listShops();
    const wanted = explicit ?? this.defaultShopId;
    if (wanted !== undefined) {
      const shop = shops.find((candidate) => candidate.id === wanted);
      if (!shop) {
        const known = shops.map((candidate) => candidate.id).join(", ") || "none";
        throw new PrintifyInputError(
          `Shop ${wanted} is not in this Printify account. Shops returned by the API: ${known}.`,
        );
      }
      return { shop, shops };
    }
    if (shops.length === 1) {
      return { shop: shops[0], shops };
    }
    if (shops.length === 0) {
      throw new PrintifyInputError("This Printify account has no shops. Connect a store in Printify first.");
    }
    const described = shops
      .map((shop) => `${shop.id} (${shop.title}, ${shop.sales_channel})`)
      .join("; ");
    throw new PrintifyInputError(
      `This account has ${shops.length} shops. Pass shopId or set PRINTIFY_SHOP_ID. Shops: ${described}.`,
    );
  }

  async verifyShop(expected: { id?: number; title?: string }): Promise<{
    verified: boolean;
    shop: PrintifyShop | null;
    shops: PrintifyShop[];
    reason: string;
  }> {
    const shops = await this.listShops();
    const title = expected.title?.trim();
    if (expected.id !== undefined && title) {
      const shop = shops.find((candidate) => candidate.id === expected.id) ?? null;
      if (!shop) {
        return { verified: false, shop: null, shops, reason: `No shop with id ${expected.id}.` };
      }
      if (normalizeTitle(shop.title) !== normalizeTitle(title)) {
        return {
          verified: false,
          shop,
          shops,
          reason: `Shop ${shop.id} is titled "${shop.title}" on sales channel "${shop.sales_channel}", not "${title}".`,
        };
      }
      return {
        verified: true,
        shop,
        shops,
        reason: `Shop ${shop.id} "${shop.title}" matches (${shop.sales_channel}).`,
      };
    }
    if (expected.id !== undefined) {
      const shop = shops.find((candidate) => candidate.id === expected.id) ?? null;
      if (!shop) {
        return { verified: false, shop: null, shops, reason: `No shop with id ${expected.id}.` };
      }
      return {
        verified: true,
        shop,
        shops,
        reason: `Shop ${shop.id} exists. Title "${shop.title}", sales channel "${shop.sales_channel}". Compare that title before publishing.`,
      };
    }
    if (title) {
      const matches = shops.filter((candidate) => normalizeTitle(candidate.title) === normalizeTitle(title));
      if (matches.length === 1) {
        return {
          verified: true,
          shop: matches[0],
          shops,
          reason: `One shop is titled "${matches[0].title}" (id ${matches[0].id}, ${matches[0].sales_channel}).`,
        };
      }
      if (matches.length === 0) {
        return { verified: false, shop: null, shops, reason: `No shop is titled "${title}".` };
      }
      return {
        verified: false,
        shop: null,
        shops,
        reason: `More than one shop is titled "${title}". Pass the shop id as well.`,
      };
    }
    const wanted = this.defaultShopId;
    if (wanted !== undefined) {
      const shop = shops.find((candidate) => candidate.id === wanted) ?? null;
      if (!shop) {
        return {
          verified: false,
          shop: null,
          shops,
          reason: `PRINTIFY_SHOP_ID ${wanted} is not in this account.`,
        };
      }
      return {
        verified: true,
        shop,
        shops,
        reason: `Configured shop ${shop.id} "${shop.title}" (${shop.sales_channel}).`,
      };
    }
    if (shops.length === 1) {
      return {
        verified: true,
        shop: shops[0],
        shops,
        reason: `The account has one shop: ${shops[0].id} "${shops[0].title}" (${shops[0].sales_channel}).`,
      };
    }
    return {
      verified: false,
      shop: null,
      shops,
      reason: "Pass a shop id and title to verify which shop this is. The account has more than one shop.",
    };
  }

  async listBlueprints(): Promise<CatalogBlueprint[]> {
    const blueprints = await this.request<unknown>("GET", "catalog/blueprints.json");
    if (!Array.isArray(blueprints)) {
      throw new PrintifyApiError("Printify catalog blueprints response was not an array.", {
        method: "GET",
        path: "/v1/catalog/blueprints.json",
      });
    }
    return blueprints as CatalogBlueprint[];
  }

  getBlueprint(blueprintId: number): Promise<CatalogBlueprint> {
    return this.request("GET", `catalog/blueprints/${blueprintId}.json`);
  }

  getBlueprintSizeGuide(blueprintId: number): Promise<unknown> {
    return this.request("GET", `catalog/blueprints/${blueprintId}/size_guide.json`);
  }

  listBlueprintPrintProviders(blueprintId: number): Promise<unknown> {
    return this.request("GET", `catalog/blueprints/${blueprintId}/print_providers.json`);
  }

  getBlueprintPrintProvider(blueprintId: number, printProviderId: number): Promise<unknown> {
    return this.request(
      "GET",
      `catalog/blueprints/${blueprintId}/print_providers/${printProviderId}.json`,
    );
  }

  /**
   * Variant placeholders include print-area width and height in pixels.
   * show-out-of-stock accepts only 0 or 1. Omitting it returns in-stock variants.
   */
  listBlueprintVariants(
    blueprintId: number,
    printProviderId: number,
    showOutOfStock = false,
  ): Promise<unknown> {
    return this.request(
      "GET",
      `catalog/blueprints/${blueprintId}/print_providers/${printProviderId}/variants.json`,
      { query: showOutOfStock ? { "show-out-of-stock": 1 } : undefined },
    );
  }

  getBlueprintShipping(blueprintId: number, printProviderId: number): Promise<unknown> {
    return this.request(
      "GET",
      `catalog/blueprints/${blueprintId}/print_providers/${printProviderId}/shipping.json`,
    );
  }

  listPrintProviders(): Promise<unknown> {
    return this.request("GET", "catalog/print_providers.json");
  }

  getPrintProvider(printProviderId: number): Promise<unknown> {
    return this.request("GET", `catalog/print_providers/${printProviderId}.json`);
  }

  async listProducts(shopId: number, page?: number, limit?: number): Promise<ProductPage> {
    return this.request("GET", `shops/${shopId}/products.json`, {
      query: {
        page: pageNumber(page),
        limit: pageLimit(limit, MAX_PRODUCT_LIMIT, 10),
      },
    });
  }

  getProduct(shopId: number, productId: string): Promise<PrintifyProduct> {
    return this.request("GET", `shops/${shopId}/products/${assertPathSegment(productId, "productId")}.json`);
  }

  createProduct(shopId: number, body: WritableProduct): Promise<PrintifyProduct> {
    return this.request("POST", `shops/${shopId}/products.json`, { body });
  }

  updateProduct(shopId: number, productId: string, body: Record<string, unknown>): Promise<PrintifyProduct> {
    return this.request("PUT", `shops/${shopId}/products/${assertPathSegment(productId, "productId")}.json`, {
      body,
    });
  }

  deleteProduct(shopId: number, productId: string): Promise<unknown> {
    return this.request("DELETE", `shops/${shopId}/products/${assertPathSegment(productId, "productId")}.json`);
  }

  publishProduct(
    shopId: number,
    productId: string,
    body: Record<string, boolean>,
  ): Promise<unknown> {
    return this.request(
      "POST",
      `shops/${shopId}/products/${assertPathSegment(productId, "productId")}/publish.json`,
      { body },
    );
  }

  unpublishProduct(shopId: number, productId: string): Promise<unknown> {
    return this.request(
      "POST",
      `shops/${shopId}/products/${assertPathSegment(productId, "productId")}/unpublish.json`,
    );
  }

  /**
   * POST publish, then GET the product until external.handle is an absolute URL
   * or the timeout elapses. publishing_succeeded is never called.
   */
  async publishAndWait(
    shopId: number,
    productId: string,
    body: Record<string, boolean>,
    timing: { timeoutMs: number; intervalMs: number },
  ): Promise<PublishPollResult> {
    await this.publishProduct(shopId, productId, body);
    const timeoutMs = timing.timeoutMs;
    const intervalMs = Math.max(timing.intervalMs, 1);
    const maxAttempts = Math.max(1, Math.ceil(timeoutMs / intervalMs) + 1);
    const deadline = this.#now() + timeoutMs;
    let attempts = 0;
    let last: PrintifyProduct | undefined;
    while (attempts < maxAttempts) {
      attempts += 1;
      last = await this.getProduct(shopId, productId);
      const storefrontUrl = storefrontUrlFromExternal(last.external);
      if (storefrontUrl) {
        return {
          publishRequested: true,
          published: true,
          storefrontUrl,
          external: last.external ?? null,
          isLocked: Boolean(last.is_locked),
          attempts,
          productId,
          message: "The product has an external storefront URL.",
        };
      }
      const remaining = deadline - this.#now();
      if (remaining <= 0 || attempts >= maxAttempts) {
        break;
      }
      await this.#sleep(Math.min(intervalMs, remaining));
    }
    const handle = last?.external?.handle;
    const relative =
      typeof handle === "string" && handle.trim() && !storefrontUrlFromExternal(last?.external)
        ? ` external.handle is "${handle.trim()}", which is not an absolute http(s) URL, so it is not treated as the storefront URL.`
        : "";
    return {
      publishRequested: true,
      published: false,
      storefrontUrl: null,
      external: last?.external ?? null,
      isLocked: Boolean(last?.is_locked),
      attempts,
      productId,
      message:
        "Publish was requested, but the product has no external storefront URL yet. " +
        "is_locked is true while Printify is still publishing. " +
        "This server does not call publishing_succeeded. " +
        "Call get_publish_status later instead of publishing again." +
        relative,
    };
  }

  async findProducts(shopId: number, query: FindProductsQuery): Promise<FindProductsResult> {
    if (!query.title && !query.tag) {
      throw new PrintifyInputError("find_products needs a title, a tag, or both.");
    }
    const maxPages = query.maxPages ?? 10;
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 40) {
      throw new PrintifyInputError("maxPages must be an integer from 1 to 40.");
    }
    const title = query.title ? normalizeTitle(query.title) : undefined;
    const tag = query.tag?.trim().toLowerCase();
    const matches: PrintifyProduct[] = [];
    let pagesScanned = 0;
    let total: number | null = null;
    for (let page = 1; page <= maxPages; page += 1) {
      const result = await this.listProducts(shopId, page, MAX_PRODUCT_LIMIT);
      pagesScanned += 1;
      total = typeof result.total === "number" ? result.total : total;
      for (const product of result.data ?? []) {
        const titleOk = title === undefined || normalizeTitle(product.title ?? "") === title;
        const tagOk =
          tag === undefined ||
          (product.tags ?? []).some((candidate) => candidate.toLowerCase() === tag);
        if (titleOk && tagOk) {
          matches.push(product);
        }
      }
      const lastPage = result.last_page ?? page;
      if (page >= lastPage || !result.next_page_url) {
        return { matches, pagesScanned, truncated: false, total };
      }
    }
    return { matches, pagesScanned, truncated: true, total };
  }

  async listUploads(page?: number, limit?: number): Promise<UploadPage> {
    return this.request("GET", "uploads.json", {
      query: {
        page: pageNumber(page),
        limit: pageLimit(limit, MAX_UPLOAD_LIMIT, 10),
      },
    });
  }

  getUpload(imageId: string): Promise<UploadImage> {
    return this.request("GET", `uploads/${assertPathSegment(imageId, "imageId")}.json`);
  }

  archiveUpload(imageId: string): Promise<unknown> {
    return this.request("POST", `uploads/${assertPathSegment(imageId, "imageId")}/archive.json`);
  }

  async uploadImage(input: {
    fileName: string;
    url?: string;
    contents?: string;
    filePath?: string;
  }): Promise<UploadImage> {
    const fileName = input.fileName.trim();
    if (!fileName) {
      throw new PrintifyInputError("fileName is required.");
    }
    const sources = [input.url, input.contents, input.filePath].filter((value) => value !== undefined && value !== "");
    if (sources.length !== 1) {
      throw new PrintifyInputError("Provide exactly one of url, contents (base64), or filePath.");
    }
    if (input.url !== undefined && input.url !== "") {
      let parsed: URL;
      try {
        parsed = new URL(input.url);
      } catch {
        throw new PrintifyInputError("url must be an absolute http(s) URL. For a local file, use filePath.");
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new PrintifyInputError("url must use http or https. For a local file, use filePath.");
      }
      return this.request("POST", "uploads/images.json", {
        body: { file_name: fileName, url: input.url },
      });
    }
    const contents = input.filePath
      ? await this.#readFileAsBase64(input.filePath)
      : this.#normalizeBase64(input.contents ?? "");
    return this.request("POST", "uploads/images.json", {
      body: { file_name: fileName, contents },
    });
  }

  #normalizeBase64(contents: string): string {
    const trimmed = contents.trim();
    const payload = trimmed.startsWith("data:") ? (trimmed.split(",")[1] ?? "") : trimmed;
    const compact = payload.replace(/\s+/g, "");
    if (!compact) {
      throw new PrintifyInputError("contents is empty.");
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
      throw new PrintifyInputError("contents must be base64, or a data:image/...;base64, URL.");
    }
    this.#assertBase64Size(compact);
    return compact;
  }

  async #readFileAsBase64(filePath: string): Promise<string> {
    let buffer: Buffer;
    try {
      buffer = await readFile(filePath);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new PrintifyInputError(`Could not read image file "${filePath}": ${reason}`);
    }
    if (buffer.length > this.#maxBase64Bytes) {
      throw new PrintifyInputError(
        `Local file is ${buffer.length} bytes. Base64 upload is limited to ${this.#maxBase64Bytes} bytes. Upload a public URL instead.`,
      );
    }
    return buffer.toString("base64");
  }

  #assertBase64Size(contents: string): void {
    const padding = contents.endsWith("==") ? 2 : contents.endsWith("=") ? 1 : 0;
    const bytes = Math.floor((contents.length * 3) / 4) - padding;
    if (bytes > this.#maxBase64Bytes) {
      throw new PrintifyInputError(
        `Base64 image is about ${bytes} bytes. Printify is dropping support for base64 uploads over 5MB. Upload a public URL instead.`,
      );
    }
  }

  #shouldRetry(method: string, status: number): boolean {
    if (status === 429) {
      return true;
    }
    return idempotentMethod(method) && (status === 502 || status === 503);
  }

  #backoff(attempt: number): number {
    return Math.min(this.#maxRetryWaitMs, this.#baseDelayMs * 2 ** attempt);
  }

  #log(message: string): void {
    this.#logger(this.redact(message));
  }

  #errorFromBody(method: string, path: string, status: number, raw: string): PrintifyApiError {
    let parsed: unknown = raw.slice(0, 2000);
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw.slice(0, 2000);
      }
    }
    const reason = errorReason(parsed);
    const code = errorCode(parsed);
    const parts = [`Printify ${method} ${path} failed with HTTP ${status}.`];
    if (reason) {
      parts.push(reason);
    }
    if (code !== undefined) {
      parts.push(`Printify error code ${code}.`);
    }
    if (status === 401 || status === 403) {
      parts.push("Check PRINTIFY_API_TOKEN and its scopes. The token is not included in this error.");
    } else if (status === 429) {
      parts.push("Printify rate limited the request and the retries were exhausted.");
    } else if (status === 409) {
      parts.push("The product is syncing with its sales channel. Try again later.");
    } else if (status === 400 || status === 422) {
      parts.push("See the Printify message above. Low-resolution artwork often fails with a validation error.");
    }
    const requestId = asRecord(parsed)?.request_id;
    if (typeof requestId === "string") {
      parts.push(`request_id ${requestId}.`);
    }
    return new PrintifyApiError(this.redact(parts.join(" ")), {
      status,
      code,
      method,
      path,
      retryable: status === 429 || status === 502 || status === 503,
    });
  }
}
