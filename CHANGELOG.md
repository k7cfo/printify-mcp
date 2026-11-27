# Changelog

## [1.0.0] - 2026-11-27

### Changed
- Replaced the `printify-sdk-js` wrapper with a direct client for the current Printify REST API (`https://api.printify.com/v1/`).
- Authentication is `PRINTIFY_API_TOKEN` from the environment only. The token is not accepted as a tool argument and is redacted from errors and logs. `PRINTIFY_API_KEY` is ignored.
- Updated the server to MCP SDK 1.32 (`registerTool` / `registerPrompt`).
- Product create-from-template copies blueprint, print provider, enabled variants, and prices, replaces one print position, and omits read-only fields.
- Publishing polls `GET` product until `external.handle` is an absolute http(s) URL. `publishing_succeeded` and `publishing_failed` are not called.
- Unpublish, delete, and archive require `confirm: true`.

### Removed
- Replicate image generation, Sharp, ImgBB, and the bundled image-generation tools.
- The mock-shop fallback that hid API failures.
- The in-tool markdown documentation tool. Printify has no public collections resource, so none is exposed.

## [0.1.1] - 2025-05-15

### Fixed
- Fixed documentation files not being included in the npm package.

## [0.1.0] - 2025-05-15

### Added
- Initial Printify MCP server published by TSavo, including shop, product, catalog, and upload tools plus Replicate image generation.
