# Shopify Admin GraphQL: applying SEO fixes from an external agent

Researched 2026-10-06 from shopify.dev (the `.md` versions of each page) plus Shopify community threads where the docs say nothing.

**Use API version `2026-10`.** It became the latest stable release on Oct 1, 2026, and is accessible until Oct 16, 2027. `2026-01`, `2026-04` and `2026-07` are also still stable. `2025-10` is no longer supported. `2027-01` is the release candidate.
Endpoint: `POST https://{shop}.myshopify.com/admin/api/2026-10/graphql.json`, with the headers `X-Shopify-Access-Token: <token>` and `Content-Type: application/json`.
Check the `X-Shopify-API-Version` response header. If it differs from the version you asked for, Shopify has fallen forward to a different version.

---

## 1. Authentication

### What changed in 2025-2026
- **You can no longer create new admin-created custom apps** (Admin > Apps > Develop apps, which handed you a `shpat_` token). Existing ones still work. Their token can't be rotated except by uninstalling and reinstalling the app. Don't delete one, because you can't recreate it.
- New apps are created in the **Dev Dashboard** (dev.shopify.com/dashboard) or with **Shopify CLI**. The Dev Dashboard replaces the Partner Dashboard for managing apps.
- How an app gets an Admin API token:
  | Situation | Grant | Token lifetime |
  |---|---|---|
  | The app and the store are in **your own Dev Dashboard organization** | **Client credentials grant** | 24 h (`expires_in: 86399`); to renew, repeat the request |
  | A **client's / merchant's store** reached from a standalone server (the agency case today, SaaS later) | **Authorization code grant** (OAuth redirect), with *custom distribution* (one store, or one Plus org) or *public distribution* (App Store) | Expiring offline token: 1 h, plus a `refresh_token` valid 90 days. Non-expiring offline tokens are still allowed for custom apps |
  | An embedded app running inside the admin | Token exchange (handled by the CLI template) | as above |
- **Public apps must use expiring offline tokens for Admin GraphQL by Jan 1, 2027.** This doesn't apply to custom apps. Build in refresh support from the start.
- The client credentials grant **does not work on a client's store** (error `shop_not_permitted`), even if you're a staff member or collaborator there. For a client store: select **Custom distribution** in the Dev Dashboard, generate an install link for the client's store, have the merchant install it, then run the authorization code grant. This choice of distribution method is permanent.

### Client credentials grant (your own org or dev stores)
```bash
curl -X POST "https://$SHOP.myshopify.com/admin/oauth/access_token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d grant_type=client_credentials -d client_id=$CLIENT_ID -d client_secret=$CLIENT_SECRET
# -> {"access_token":"shpat_...","scope":"read_products,...","expires_in":86399}
```
The scopes come from the **app version** released in the Dev Dashboard; the token request can't ask for scopes. If you add a scope in a new version, the merchant has to approve it on the store before it takes effect.

### Authorization code grant (client or merchant stores)
1. Redirect to `https://{shop}/admin/oauth/authorize?client_id=..&scope=..&redirect_uri=..&state=<nonce>`.
2. On the callback: verify `state` and the `hmac` (HMAC-SHA256 of the sorted query parameters, keyed with the client secret, compared in constant time).
3. `POST https://{shop}/admin/oauth/access_token` with `client_id`, `client_secret`, `code` and `expiring=1`. You get back `access_token`, `refresh_token` and `expires_in`.
4. To refresh: `POST /admin/oauth/access_token` with `grant_type=refresh_token&refresh_token=...`. Every refresh returns a *new* refresh token; store it. Don't refresh and re-acquire a token for the same store at the same time, because each invalidates the other's result.

### Scopes for an SEO agent
| Scope | Covers |
|---|---|
| `write_products` (includes read) | product and collection `seo`, handle, metafields, `fileUpdate` alt text on product media (via product permissions) |
| `write_content` **or** `write_online_store_pages` | pages, blogs, articles (`pageUpdate`, `articleUpdate`, `blogUpdate`) and their metafields |
| `write_online_store_navigation` | `urlRedirect*` mutations (scope tables list `UrlRedirect` under this scope) |
| `write_files` | `fileUpdate` (alt text), `stagedUploadsCreate` for files |
| `read_themes` | read theme files (robots.txt.liquid, theme.liquid) for auditing |
| `write_themes` | theme file writes. **This also requires a Shopify exemption** (see section 5) |
| `write_translations` (optional) | localized SEO titles and descriptions |
| `write_metaobjects` / `write_metaobject_definitions` (optional) | if you store JSON-LD or FAQ data as metaobjects |

A write scope includes the matching read scope. Request the smallest set you need.

### Verifying the connection
```graphql
query Verify {
  shop { name myshopifyDomain primaryDomain { url host } plan { publicDisplayName shopifyPlus } }
  currentAppInstallation { accessScopes { handle } }
}
```
`currentAppInstallation.accessScopes` lists the scopes actually *granted* on the store, which can differ from the ones declared on the app. Fail early if any required scope is missing. Use `primaryDomain.url` as the base for storefront checks.

---

## 2. SEO fields

### Data model
- **Products and collections** have a first-class `seo { title description }` field (`SEO` object, `SEOInput`). In storage these are the metafields `global.title_tag` and `global.description_tag` (type `single_line_text_field`). Shopify's collectionUpdate example shows `seo` and these metafields mirroring each other.
- **Pages, articles and blogs have no `seo` field** in the Admin API. Their SEO title and description live **only** in the `global.title_tag` and `global.description_tag` metafields. Write them with `metafieldsSet` or the `metafields` input on the update mutation.
- **noindex**: the metafield `seo.hidden` with value `"1"` and type `number_integer` adds `noindex,nofollow` and drops the resource from the sitemap *and from storefront search*. Delete the metafield to undo it.
- Leaving the SEO title or description empty makes the theme fall back to the resource title and description (or excerpt).

### Product
```graphql
mutation SeoProduct($product: ProductUpdateInput!) {
  productUpdate(product: $product) {
    product { id handle seo { title description } }
    userErrors { field message }
  }
}
# variables
{ "product": { "id": "gid://shopify/Product/123",
  "seo": { "title": "Matte Black Sunglasses | Brand", "description": "..." } } }
```
- Use the `product:` argument (`ProductUpdateInput`). The old `input:` (`ProductInput`) is **deprecated**.
- `productUpdate` also accepts an `identifier: { id | handle | customId }` argument (`ProductUpdateIdentifiers`), so you can update by handle without looking up the ID first.
- Changing the handle: `{ "id": "...", "handle": "new-handle", "redirectNewHandle": true }`. **`redirectNewHandle` defaults to `false`**, so always set it, otherwise the old URL returns a 404.
- Resource throttle: once a store has a very large number of variants, `productUpdate` is limited per day (the mutation page says 50k variants and 1,000 per day; the rate-limit page says 500k and 10k per day; neither applies on Plus). If you get a 429 "throttle applied", back off until the next day.

### Collection
```graphql
mutation SeoCollection($collection: CollectionUpdateInput!) {
  collectionUpdate(collection: $collection) {
    collection { id handle seo { title description } }
    userErrors { field message }
  }
}
{ "collection": { "id": "gid://shopify/Collection/456",
  "seo": { "title": "...", "description": "..." }, "handle": "new", "redirectNewHandle": true } }
```
Use the `collection:` argument (`CollectionUpdateInput`). The old `input:` is deprecated. Scope is `write_products`. This mutation is not available on the Starter or Retail plans.

### Page (pageUpdate exists in the current API)
```graphql
mutation SeoPage($id: ID!, $page: PageUpdateInput!) {
  pageUpdate(id: $id, page: $page) {
    page { id handle title
      titleTag: metafield(namespace:"global", key:"title_tag"){ value }
      descTag:  metafield(namespace:"global", key:"description_tag"){ value } }
    userErrors { field message }
  }
}
{ "id": "gid://shopify/Page/789", "page": {
  "metafields": [
    {"namespace":"global","key":"title_tag","type":"single_line_text_field","value":"About Us | Brand"},
    {"namespace":"global","key":"description_tag","type":"single_line_text_field","value":"..."}],
  "handle": "about", "redirectNewHandle": true } }
```
`PageUpdateInput` fields: `body`, `handle`, `isPublished`, `metafields`, `publishDate`, `redirectNewHandle` (default false), `templateSuffix`, `title`.

### Blog article
```graphql
mutation SeoArticle($id: ID!, $article: ArticleUpdateInput!) {
  articleUpdate(id: $id, article: $article) {
    article { id handle summary image { altText } }
    userErrors { field message }
  }
}
{ "id": "gid://shopify/Article/1", "article": {
  "metafields": [ {"namespace":"global","key":"title_tag","type":"single_line_text_field","value":"..."},
                  {"namespace":"global","key":"description_tag","type":"single_line_text_field","value":"..."} ],
  "summary": "<p>excerpt</p>",
  "image": { "url": "https://...", "altText": "Descriptive alt" },
  "handle": "new-slug", "redirectNewHandle": true } }
```
`ArticleUpdateInput` fields: `author`, `blogId`, `body`, `handle`, `image {url altText}`, `isPublished`, `metafields`, `publishDate`, `redirectNewHandle`, `summary`, `tags`, `templateSuffix`, `title`. Use `blogUpdate` (`BlogUpdateInput`) for the blog index's metafields.

### Generic way to write metafields (any owner type), with compare-and-set
```graphql
mutation SetSeo($m: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $m) {
    metafields { id namespace key value compareDigest }
    userErrors { field message code }
  }
}
{ "m": [ { "ownerId": "gid://shopify/Page/789", "namespace": "global", "key": "title_tag",
           "type": "single_line_text_field", "value": "New title",
           "compareDigest": "<digest read earlier, or null if it must not exist yet>" } ] }
```
- Up to **25 metafields per call**. The call is **atomic**: nothing is saved if any metafield errors.
- `compareDigest` (available since 2024-07) gives optimistic concurrency. The write is rejected if a merchant edited the value after the agent read it. **Use it for every approved fix**, so a stale approval can't overwrite a human's edit.
- Deleting: `metafieldsDelete(metafields: [{ownerId, namespace, key}])` (use it to undo `seo.hidden`, or to revert to "unset").
- Required permission: whatever is needed to edit the owner resource (write_products for products, write_content for pages, and so on).

### Looking up a resource from a URL
Parse the storefront path `/{locale?}/products|collections|pages|blogs/{blog}/{article}`:
```graphql
query ByUrl($h: String!) {
  productByIdentifier(identifier: { handle: $h }) { id handle title seo { title description } }
}
query Coll($h: String!) { collectionByIdentifier(identifier: { handle: $h }) { id seo { title description } } }
query Pg($q: String!)   { pages(first: 1, query: $q) { nodes { id handle title
                           t: metafield(namespace:"global",key:"title_tag"){ value compareDigest } } } }  # $q = "handle:about"
query Art($q: String!)  { articles(first: 5, query: $q) { nodes { id handle blog { handle } } } }      # $q = "handle:my-post"
query Blogs             { blogs(first: 50) { nodes { id handle } } }
```
- **`productByHandle` and `collectionByHandle` are deprecated.** Use `productByIdentifier` and `collectionByIdentifier` (`{ id | handle | customId }`).
- Pages and articles have no `*ByIdentifier` query. Use the `query: "handle:..."` filter, then **match the handle exactly** on the client (for articles, also match `blog.handle`), because search filters can return near matches.
- Handles can collide across locales or markets. Strip the market or locale prefix before matching.

---

## 3. Image alt text
- **Product media**: `productUpdateMedia` is **deprecated**. Use `fileUpdate` (scope `write_files`, or `write_themes`; the user also needs edit-files permission). The `MediaImage` ID on a product is the same as its File ID.
```graphql
query Media($id: ID!) { product(id: $id) { media(first: 50) { nodes { id alt mediaContentType
  ... on MediaImage { image { url } fileStatus } } } } }

mutation Alt($files: [FileUpdateInput!]!) {
  fileUpdate(files: $files) {
    files { id alt ... on MediaImage { fileStatus } }
    userErrors { field message code }
  }
}
{ "files": [ { "id": "gid://shopify/MediaImage/111", "alt": "Matte black aviator sunglasses, side view" } ] }
```
  - `FileUpdateInput` fields: `id`, `alt`, `filename`, `originalSource`, `previewImageSource`, `referencesToAdd`, `referencesToRemove`.
  - A file must be in the `READY` state before it can be updated. Files are locked during updates, so retry on a lock conflict.
  - **Only send `id` and `alt`.** Leave `referencesToRemove` out: removing a product reference deletes the image from the gallery and clears it from variants.
  - Up to 250 items per input array.
- **Article featured image**: `articleUpdate` → `article.image.altText`.
- **Collection image**: `collectionUpdate` → `collection.image { altText }` (`ImageInput`: `id`, `src`, `altText`).
- **Images inside body HTML** (pages, articles, product descriptions): rewrite the `<img alt="">` in `body` or `descriptionHtml`. This replaces the whole HTML, so keep the original for rollback.
- **Theme or section images** (images set in the theme editor): alt text lives in the theme JSON or settings, which means theme writes (see section 5).

---

## 4. Redirects
```graphql
mutation R($r: UrlRedirectInput!) { urlRedirectCreate(urlRedirect: $r) {
  urlRedirect { id path target } userErrors { field message code } } }
{ "r": { "path": "/products/old-handle", "target": "/products/new-handle" } }

mutation U($id: ID!, $r: UrlRedirectInput!) { urlRedirectUpdate(id: $id, urlRedirect: $r) { urlRedirect { id path target } userErrors { field message } } }
mutation D($id: ID!) { urlRedirectDelete(id: $id) { deletedUrlRedirectId userErrors { field message } } }
query  L($q: String) { urlRedirects(first: 250, query: $q) { nodes { id path target } } }   # $q = "path:/old"
```
- The scope is **`write_online_store_navigation`**, not write_content.
- **Bulk**: upload a CSV with `stagedUploadsCreate`, then `urlRedirectImportCreate(url:)`, then `urlRedirectImportSubmit(id:)`, then poll the `UrlRedirectImport`.
- **Handle changes**: pass `redirectNewHandle: true` in productUpdate, collectionUpdate, pageUpdate or articleUpdate (it defaults to **false**). The redirect is created automatically. Read `urlRedirects(query:"path:/products/old")` afterwards to record its ID for rollback.
- From the Shopify Help Center:
  - **A redirect only fires if the old URL is broken (404).** If the path still resolves to a live resource, the redirect is silently ignored.
  - You can't redirect from fixed paths such as `/products`, `/collections`, `/collections/all`, `/cart`, `/orders`, `/account`, `/services` or `/shop`.
  - URLs with query strings may not redirect.
  - Market or locale subfolders are **not** redirected automatically; create a redirect for each prefix.
  - The limit is 100,000 redirects (20M on Plus).
  - Avoid chains and loops: check that the target isn't itself a redirect `path`.

---

## 5. Theme-level changes (robots.txt, JSON-LD, meta tags)

### The hard constraint
`themeFilesUpsert` (and `themeFilesCopy` / `themeFilesDelete`) needs **`write_themes` plus an exemption from Shopify** (granted per app or client ID, through Shopify's exemption request form). Without the exemption the call returns `ACCESS_DENIED: "The user needs write_themes and an exemption from Shopify to modify theme files."` The legacy REST Asset API PUT/DELETE has been gated the same way since 2023-04.
- The access-scopes doc says the exemption is required for **public-distribution** apps. In practice the GraphQL mutation enforces it per client ID, and Shopify staff on the forum describe exemptions per app, including dev and custom apps. **Assume you need an exemption even for a custom-distribution app, and test with a dev store.**
- Shopify **denied** a June 2026 exemption request for "merchant-approves-a-diff, then the app writes the theme file". Staff said the alternatives are app embeds, theme app extensions, or collaborator access. Treat the exemption as unlikely for a general SEO agent. A public App Store app may modify themes **only** through theme app extensions.
- Fallback for one agency client: the agency gets **collaborator access** and makes theme edits with Shopify CLI (`shopify theme pull`/`push`) or in the code editor. This is a human-approved path outside the Admin API.

### If you do have an exemption
```graphql
query MainTheme { themes(first: 1, roles: [MAIN]) { nodes { id name role } } }
query ReadFile($id: ID!) { theme(id: $id) { files(filenames: ["templates/robots.txt.liquid","layout/theme.liquid"], first: 2) {
  nodes { filename checksumMd5 body { ... on OnlineStoreThemeFileBodyText { content } } } } } }

mutation Upsert($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
  themeFilesUpsert(themeId: $themeId, files: $files) {
    upsertedThemeFiles { filename }
    job { id done }
    userErrors { filename code message }
  }
}
{ "themeId": "gid://shopify/OnlineStoreTheme/1",
  "files": [ { "filename": "snippets/seo-jsonld.liquid", "body": { "type": "TEXT", "value": "..." } } ] }
```
- Body `type` is one of `TEXT`, `BASE64` or `URL`. Up to 50 files per call. The mutation is asynchronous: poll `job(id:){done}`.
- Safe workflow: `themeDuplicate` (or work on an UNPUBLISHED copy), write there, preview with `https://{domain}/?preview_theme_id=<id>`, then `themePublish`. At minimum, snapshot the file body or checksum before writing.
- `robots.txt.liquid` (`templates/robots.txt.liquid`) **replaces** Shopify's generated robots.txt. Build it from `robots.default_groups` and add rules to that, rather than writing plain text. Save the current `/robots.txt` output first and diff the rendered result. A mistake here can de-index the whole store, so it should always require approval.

### Preferred alternative for JSON-LD and head tags: data in metafields, rendered by a snippet
1. One time, with a human or theme app extension, install a snippet or **app embed block** (theme app extension, `target: head`) that renders, for example: `{% if product.metafields.seo_agent.jsonld %}<script type="application/ld+json">{{ product.metafields.seo_agent.jsonld }}</script>{% endif %}` (and likewise for `page`, `article`, `collection` and `shop`). Theme app extensions need **no exemption**, survive theme switches, and can be deployed by your app (Shopify CLI `shopify app deploy`). The merchant enables the embed in the theme editor.
2. After that, the agent only writes data: `metafieldsSet` with namespace `seo_agent`, key `jsonld` and type `json` (or `multi_line_text_field`), owned by the product, page, etc. Updates are atomic and per resource, and rollback is just deleting or restoring the metafield.
3. Check what the theme already outputs (many themes emit Product JSON-LD via `structured_data`) so you don't produce duplicate or conflicting schema.
4. Shopify's own advice for meta-tag SEO apps is an app embed block targeting `<head>`.
5. Caching caveat: in Sept 2025, app-owned metafields (`app.metafields`) read in theme app extensions were reported to be cached for hours. Prefer resource-owned metafields, and verify (section 7).

---

## 6. Rate limits, bulk operations, rollback

### Cost-based throttle (leaky bucket, per app and store)
| Plan | Restore rate |
|---|---|
| Standard | 100 pts/s |
| Advanced | 200 pts/s |
| Plus | 1000 pts/s |
| Enterprise | 2000 pts/s |

- A mutation costs about 10 points, an object 1, a scalar 0, and a connection scales with `first`/`last`.
- A single query can cost at most **1,000** points (checked against the requested cost before it runs).
- Input arrays are capped at **250** items. Pagination stops at 25,000 objects.
- Every response carries `extensions.cost { requestedQueryCost, actualQueryCost, throttleStatus { maximumAvailable, currentlyAvailable, restoreRate } }`. Send the header `Shopify-GraphQL-Cost-Debug=1` to see costs per field.
- When throttled you get HTTP 200 with `errors[].extensions.code == "THROTTLED"`. Wait `(requested - currentlyAvailable) / restoreRate` seconds (at least 1 s) and retry. Run each store through its own queue at a pace the bucket can sustain.
- `userErrors` are business errors and do **not** throw. Check them on every mutation.

### Bulk (100s to 1000s of resources)
- **Read**: `bulkOperationRunQuery(query: "{ products { edges { node { id handle seo { title description } media { edges { node { id alt } } } } } } }")`. The result is a JSONL file. It has no cost limits.
- **Write**:
  1. Call `stagedUploadsCreate(input:[{resource: BULK_MUTATION_VARIABLES, filename:"vars.jsonl", mimeType:"text/jsonl", httpMethod: POST}])`.
  2. POST the multipart upload: one JSON variables object per line, for example `{"product":{"id":"gid://...","seo":{"title":"..."}}}`.
  3. Call `bulkOperationRunMutation(mutation: "mutation($product: ProductUpdateInput!){ productUpdate(product:$product){ product{id} userErrors{field message} } }", stagedUploadPath: "<key param>")`.
- Limits: the JSONL file can be at most 100 MB; the operation must finish within 24 h; from 2026-01 on, up to **5 concurrent bulk mutations** per app and shop.
- Track an operation with `bulkOperation(id:)` or `bulkOperations` (`currentBulkOperation` is deprecated from 2026-01), or with the `bulk_operations/finish` webhook. Webhook delivery isn't guaranteed, so poll as well.
- The result JSONL contains a per-line `userErrors` entry. Parse it to find partial failures. A bulk operation is **not** atomic.
- `metafieldsSet` (25 per call) is also usable in bulk.

### Rollback design
1. **Before every write**, snapshot the exact prior state into the change log: resource GID, handle, `seo{title description}` or the `global.*` metafield values **with `compareDigest`**, media `alt`, body HTML, redirect IDs, and theme file `checksumMd5` plus body.
2. Write with `compareDigest` where possible. Record the returned new values and digests.
3. **Rollback** means re-applying the snapshot with the same mutations:
   - If the metafield didn't exist before, delete it with `metafieldsDelete`. If it was empty, set it back.
   - If the handle changed, set the old handle back with `redirectNewHandle:false`, then `urlRedirectDelete` the redirect that was created automatically. Otherwise the restored URL is ignored because of the redirect loop or 404 rule.
   - Theme: restore the snapshot body, or republish the previous theme.
4. Before rolling back, re-read the resource. If the current value no longer matches what the agent wrote (someone else edited it), stop and ask instead of overwriting.
5. Make retries idempotent: key each change by `{resourceGid, field, newValueHash}`. Shopify also documents idempotent request handling (`/docs/api/usage/idempotent-requests`).

---

## 7. Checking that the storefront reflects the change
1. **Admin read-back** (authoritative, immediate): re-query the resource and compare the field. Mark the change "applied".
2. **Live HTML check**: GET `{primaryDomain}{path}` (plus market or locale variants) with a cache-buster such as `?_sa=<timestamp>` and the header `Cache-Control: no-cache`, using a normal browser User-Agent. Parse `<title>`, `meta[name=description]`, `link[rel=canonical]`, `meta[name=robots]`, `<script type="application/ld+json">`, `img[alt]` and `/robots.txt`. Mark the change "live".
3. **Caching**: Shopify's storefront and CDN cache rendered pages. Admin saves usually show up within seconds to a few minutes. Community reports from 2026 mention 5-10 minute delays in some cases, and cached `app.metafields` for hours (2025). There is **no API to purge the storefront cache**. Poll with backoff (for example 30 s, 1 m, 2 m, 5 m, 10 m, 20 m) and flag the change if it still isn't live after about 30 min, instead of re-applying it.
4. Redirects: GET the old path without following redirects. Expect a 301 and a `Location` header pointing at the target. Remember the redirect won't fire if the old path still resolves.
5. Theme changes: check with `?preview_theme_id=` before publishing, then check the live page.
6. Search engines: a live change isn't indexed until Google recrawls. Optionally request reindexing or submit the sitemap through Search Console (outside Shopify).

---

## Other gotchas
- Pages, articles and blogs have no `seo` field; use the `global.title_tag` and `global.description_tag` metafields.
- `productUpdate(input:)` and `collectionUpdate(input:)` are deprecated; use `product:` and `collection:`.
- `productUpdateMedia` is deprecated; use `fileUpdate`. `productByHandle` and `collectionByHandle` are deprecated; use `*ByIdentifier`.
- Multi-language stores: translated SEO values are separate *translations* (`translationsRegister`, `write_translations`) keyed per translatable resource. Read `translatableResource(resourceId:){ translatableContent { key value digest locale } }` for the exact keys (for example the title_tag and description_tag keys) before writing. This wasn't verified in depth here.
- Deprecated calls are attributed to the app's token. Don't reuse the agent's token in Postman or other tools.
- The sample code in the client-credentials tutorial hard-codes `/admin/api/2025-01/`, which is now unsupported (it falls forward). Pin `2026-10` explicitly and plan to upgrade each quarter. `2026-10` is accessible until Oct 16, 2027.

## Sources
- Versioning and release table: https://shopify.dev/docs/api/usage/versioning
- 2026-10 release notes: https://shopify.dev/changelog/release-notes/2026-10
- Auth overview: https://shopify.dev/docs/apps/build/authentication-authorization
- Access tokens (lifetimes, expiring offline tokens, 2027 deadline): https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens
- Client credentials grant: https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant
- Standalone app OAuth: https://shopify.dev/docs/apps/build/authentication-authorization/authenticate-standalone-apps
- Dev Dashboard apps: https://shopify.dev/docs/apps/build/dev-dashboard/create-apps-using-dev-dashboard
- Legacy admin-created custom apps: https://shopify.dev/docs/apps/build/authentication-authorization/legacy/admin-custom-apps
- Distribution: https://shopify.dev/docs/apps/launch/distribution/select-distribution-method
- Access scopes and theme exemption: https://shopify.dev/docs/api/usage/access-scopes
- SEO metafields guide: https://shopify.dev/docs/apps/build/marketing/optimize-storefront-seo
- productUpdate / ProductUpdateInput / collectionUpdate / pageUpdate / articleUpdate / metafieldsSet / fileUpdate / productUpdateMedia / urlRedirect* / themeFilesUpsert / productByIdentifier: https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/<name> and https://shopify.dev/docs/api/admin-graphql/2026-10/queries/<name>
- Rate limits: https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits and https://shopify.dev/docs/api/usage/limits
- Bulk imports: https://shopify.dev/docs/api/usage/bulk-operations/imports
- robots.txt: https://shopify.dev/docs/storefronts/themes/seo/robots-txt
- Redirect rules (only from broken URLs, market subfolders): https://help.shopify.com/en/manual/online-store/menus-and-links/url-redirect
- Theme exemption in practice: https://community.shopify.dev/t/unable-to-edit-theme-files-in-shopify-embedded-app-write-themes-scope-added/25391 , https://community.shopify.dev/t/theme-api-write-exemption-denied-is-single-file-per-change-merchant-approved-writing-ever-approvable-or-is-app-embeds-the-only-path/35406 , https://community.shopify.dev/t/themefilescopy-access-denied-on-dev-app-despite-approved-write-themes-exemption/34703
- Storefront cache delay: https://community.shopify.com/t/product-updates-not-reflecting-immediately-on-storefront-5-10-minute-delay-in-same-browser/637606 , https://community.shopify.dev/t/app-metafields-in-theme-app-extension-are-cached-in-liquid-for-several-hours-before-refreshing/23217
