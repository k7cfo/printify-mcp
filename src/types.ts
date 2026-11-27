/** Shop record from GET /v1/shops.json. All three fields are read-only. */
export interface PrintifyShop {
  id: number;
  title: string;
  sales_channel: string;
}

export interface CatalogBlueprint {
  id: number;
  title: string;
  description?: string | null;
  brand?: string;
  model?: string;
  images?: string[];
  tags?: string[];
  features?: Array<{ name?: string | null; description?: string | null; image?: string | null }>;
  care_instructions?: string[];
}

export interface CatalogPlaceholder {
  position: string;
  decoration_method?: string;
  height?: number;
  width?: number;
}

export interface CatalogVariant {
  id: number;
  title: string;
  options?: Record<string, string>;
  placeholders?: CatalogPlaceholder[];
  decoration_methods?: string[];
}

export interface ProductImageLayer {
  id?: string;
  src?: string;
  name?: string;
  type?: string;
  height?: number;
  width?: number;
  x?: number;
  y?: number;
  scale?: number;
  angle?: number;
  input_text?: string;
  pattern?: {
    spacing_x?: number | null;
    spacing_y?: number | null;
    angle?: number | null;
    offset?: number | null;
  };
}

export interface ProductPlaceholder {
  position: string;
  decoration_method?: string;
  images?: ProductImageLayer[];
}

export interface ProductPrintArea {
  variant_ids: number[];
  placeholders?: ProductPlaceholder[];
  background?: string;
}

export interface ProductVariant {
  id: number;
  price: number;
  is_enabled?: boolean;
  is_default?: boolean;
  sku?: string;
  title?: string;
  cost?: number;
  grams?: number;
  is_available?: boolean;
  options?: number[];
}

export interface MockupImage {
  mockup_id?: string;
  src?: string;
  variant_ids?: number[];
  position?: string;
  is_default?: boolean;
}

export interface ProductExternal {
  id?: string;
  handle?: string;
  shipping_template_id?: string;
}

export interface PrintifyProduct {
  id: string;
  title: string;
  description?: string;
  safety_information?: string;
  tags?: string[];
  options?: unknown;
  variants: ProductVariant[];
  images?: MockupImage[];
  created_at?: string;
  updated_at?: string;
  visible?: boolean;
  blueprint_id: number;
  print_provider_id: number;
  user_id?: number;
  shop_id?: number;
  print_areas?: ProductPrintArea[];
  print_details?: Record<string, unknown> | unknown[];
  external?: ProductExternal | null;
  is_locked?: boolean;
  views?: unknown;
  sales_channel_properties?: Record<string, unknown> | unknown[] | null;
}

export interface ProductPage {
  current_page?: number;
  data?: PrintifyProduct[];
  last_page?: number;
  total?: number;
  per_page?: number;
  next_page_url?: string | null;
}

export interface UploadImage {
  id: string;
  file_name: string;
  height: number;
  width: number;
  size: number;
  mime_type: string;
  preview_url: string;
  upload_time: string;
}

export interface UploadPage {
  current_page?: number;
  data?: UploadImage[];
  last_page?: number;
  total?: number;
  per_page?: number;
  next_page_url?: string | null;
}

export interface WritableImage {
  id: string;
  x: number;
  y: number;
  scale: number;
  angle: number;
}

export interface WritablePlaceholder {
  position: string;
  images: WritableImage[];
}

export interface WritablePrintArea {
  variant_ids: number[];
  placeholders: WritablePlaceholder[];
}

export interface WritableVariant {
  id: number;
  price: number;
  is_enabled: boolean;
  is_default?: boolean;
}

/** Fields Printify accepts on POST /v1/shops/{shop_id}/products.json. */
export interface WritableProduct {
  title: string;
  description?: string;
  tags?: string[];
  safety_information?: string;
  blueprint_id: number;
  print_provider_id: number;
  variants: WritableVariant[];
  print_areas: WritablePrintArea[];
  visible?: boolean;
  print_details?: {
    print_on_side?: string;
    separator_type?: string;
    separator_color?: string;
  };
  sales_channel_properties?: Record<string, unknown>;
}

export interface PublishPollResult {
  publishRequested: true;
  published: boolean;
  storefrontUrl: string | null;
  external: ProductExternal | null;
  isLocked: boolean;
  attempts: number;
  productId: string;
  message: string;
}
