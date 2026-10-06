# SEO Autopilot — Shopify setup

The Shopify adapter (`packages/core/src/adapters/shopify.ts`) talks to the **Admin GraphQL API
(version `2026-10` by default, override with `shopify_api_version` in the site config)**.
It needs two one-time things: an app with the right scopes, and a small theme snippet that
prints the JSON-LD the agent stores in metafields.

## 1. Install the theme snippet (once per theme)

1. Shopify admin → **Online Store → Themes** → on the live theme, **… → Edit code**.
2. Under **Snippets**, click **Add a new snippet**, name it `seo-agent-jsonld`, and paste the
   contents of [`seo-agent-jsonld.liquid`](./seo-agent-jsonld.liquid). Save.
3. Open **Layout → `theme.liquid`** and add this line just before `</head>`:

   ```liquid
   {% render 'seo-agent-jsonld' %}
   ```
4. Save. The storefront HTML now contains `<!-- seo-agent-jsonld -->`; the adapter's connection
   test looks for that marker and warns if it is missing.

If you switch or duplicate themes later, repeat steps 2–3 on the new theme.

The snippet prints the `seo_agent.jsonld` metafield (type `json`, an array of schema.org objects)
of the current product, collection, page, article or blog, and the shop-level
`shop.metafields.seo_agent.jsonld` on the homepage. Values are serialised with Liquid's `json`
filter; the agent also refuses to store schema containing `</script` or `<!--`.

> Many themes already print Product / Organization / BreadcrumbList JSON-LD (often via
> `{{ product | structured_data }}`). Check the theme before approving a `jsonld_add` of the
> same `@type`, or you'll ship duplicate schema.

## 2. Create the app and get credentials (2026 flow)

**Legacy "Develop apps" custom apps in the Shopify admin can no longer be created** (existing ones
keep working — if you already have a `shpat_` token from one, paste it as `access_token` and skip
to the scopes list). New apps are created in the **Dev Dashboard**:

1. Go to <https://dev.shopify.com/dashboard> → **Apps → Create app** → "Start from Dev Dashboard".
2. In the app's **Versions** tab, create a version with these **Admin API access scopes**:

   | Scope | Used for |
   |---|---|
   | `write_products` | product & collection SEO title/description, product/collection metafields (noindex, JSON-LD) |
   | `write_content` *(or `write_online_store_pages`)* | page / blog / article SEO metafields and page/article body edits |
   | `write_online_store_navigation` | URL redirects (`urlRedirectCreate/Update/Delete`) |
   | `write_files` | product image alt text (`fileUpdate`) |
   | `read_themes` | reading `robots.txt.liquid` / `theme.liquid` during audits |

   Release the version. (Scopes come from the released version; adding one later needs the
   merchant to approve the update.)
3. Install and authenticate:
   * **Store in your own Dev Dashboard organization** (your own store, or a dev store): install the
     app on the store, then copy the app's **Client ID** and **Client secret** into the site's
     secrets (`client_id`, `client_secret`). The runner uses the **client credentials grant**
     (`POST https://{shop}/admin/oauth/access_token`, `grant_type=client_credentials`) and caches
     the 24-hour token, refreshing 5 minutes before expiry.
   * **A client's / merchant's store** (not in your org): client credentials fail with
     `shop_not_permitted`. Choose **Custom distribution** for the app in the Dev Dashboard (this is
     permanent), generate an install link for that store, have the merchant install it, and run the
     OAuth **authorization code grant** to obtain an offline access token. Paste that token as
     `access_token`. (Expiring offline tokens + refresh are not handled by the runner yet; request a
     non-expiring offline token, which custom apps are still allowed to use.)
4. In the control panel, set the site's **shop** to `your-store.myshopify.com` and run
   **Test connection**. Missing scopes are reported as warnings.

## 3. What the agent changes automatically

| Change type | Products | Collections | Pages | Articles | Blogs | Homepage `/` |
|---|---|---|---|---|---|---|
| `title`, `meta_description` | `seo { title description }` | `seo { … }` | `global.title_tag` / `global.description_tag` metafields | same | same | manual |
| `robots_meta` (noindex ↔ index) | `seo.hidden` metafield | same | same | same | same | — |
| `image_alt` | product media via `fileUpdate` | manual | manual | manual | — | — |
| `jsonld_add`, `jsonld_fix` | `seo_agent.jsonld` metafield | same | same | same | same | shop metafield |
| `content_edit` (exact find/replace only) | manual | manual | body | body | — | — |
| `redirect` | store-wide `urlRedirect*` | | | | | |

All metafield writes use `metafieldsSet` with `compareDigest`, so an approval can never overwrite
an edit a merchant made after the agent read the value. Rollback restores the previous value, or
deletes the metafield/redirect if the agent created it.

Notes:
* `seo.hidden = 1` means **noindex, nofollow and removed from the sitemap and storefront search**;
  Shopify has no index,nofollow switch.
* Shopify redirects only fire when the old path returns 404.
* There is no storefront cache purge API; changes usually appear within seconds to minutes
  (verification retries for up to ~30 min).

## 4. What stays manual (the agent turns these into advice)

* **robots.txt** — customise `templates/robots.txt.liquid` in the theme (start from
  `robots.default_groups`). Theme file writes via the API need a Shopify exemption that is not
  granted to SEO tools.
* **Homepage title / meta description** — Online Store → Preferences.
* **Open Graph / Twitter tags, canonical, hreflang** — printed by the theme (`theme.liquid`,
  social-meta snippet) and Shopify Markets.
* **H1** — on Shopify it is the product/collection/page title; changing it renames the item.
* **URL handles (slug)**, **internal links**, **llms.txt**, images inside descriptions/sections.
