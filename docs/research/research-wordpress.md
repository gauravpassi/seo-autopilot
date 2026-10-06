# WordPress write-side reference for an autonomous SEO agent

Researched 2026-10-06. Plugin facts were checked against the current wordpress.org stable source code: Yoast SEO 28.6, Rank Math 1.0.279, SEOPress 10.3, AIOSEO 5.0.2.1, Redirection 5.10.1 and LiteSpeed Cache. Core facts were checked against wordpress-develop trunk. Line-level behaviour was taken from the code where docs were vague.

---

## 0. TL;DR architecture

1. **Auth:** use an Application Password for a dedicated `seo-agent` user (Administrator, or Editor plus the SEO-plugin caps listed below). Send it with HTTP Basic over HTTPS.
2. **Core fields** (title, slug, content, excerpt, featured image, alt text): use `/wp/v2/*`.
3. **SEO meta:** use this order of preference:
   - (a) the **companion mu-plugin** described in section 7. It is deterministic, works with any SEO plugin and gives one endpoint for read, write, snapshot and purge.
   - (b) the plugin-native **Abilities API** (WP 6.9+) or the plugin's own REST routes.
   - (c) plain `meta` on `/wp/v2/posts`. This works only where the plugin registered the meta with `show_in_rest`.
4. **Rollback:** before every write, take your own snapshot of the exact old values. Do not rely on WP revisions alone, because revisions don't capture most SEO meta.
5. **After a write:** purge the caches (plugin, then CDN), re-fetch the live URL with a cache-buster, parse the `<head>` and compare it with the expected values.

---

## 1. Authentication

### Application Passwords (core since WP 5.6)
- **Where to create one:** go to Users → Profile → *Application Passwords*. The UI shows a password of 24 characters split into groups of 4 by spaces. The spaces are optional when you send it.
- **Request header:** `Authorization: Basic base64("username:xxxx xxxx xxxx xxxx xxxx xxxx")`.
- **Availability:** `wp_is_application_passwords_available()`. It defaults to `wp_is_application_passwords_supported()`, which is `is_ssl() || wp_get_environment_type()==='local'`. In practice that means **HTTPS is required**. A site can also turn the feature off with these filters:
  - `add_filter('wp_is_application_passwords_available','__return_false')`
  - `wp_is_application_passwords_available_for_user`
- **Detection:** `GET /wp-json/` returns
  `authentication.application-passwords.endpoints.authorization` (the URL of `wp-admin/authorize-application.php`). If that key is missing, the feature is disabled.
- **Interactive onboarding flow** (no copy-paste needed):
  `https://site/wp-admin/authorize-application.php?app_name=SEO%20Agent&app_id=<uuid>&success_url=https://agent/callback`
  On approval, WP redirects to `success_url?site_url=…&user_login=…&password=…`. The `success_url` must be HTTPS.
- **REST endpoints:**
  - `GET|POST /wp/v2/users/me/application-passwords`
  - `GET|POST|DELETE /wp/v2/users/me/application-passwords/<uuid>`
  - `GET /wp/v2/users/me/application-passwords/introspect` returns the password currently in use. This is useful for showing "connected as" and for revocation.

### Verify the connection
```
GET /wp-json/wp/v2/users/me?context=edit
Authorization: Basic …
```
- 200 with `roles` and `capabilities` means the connection works. Check that `capabilities.edit_others_posts`, `edit_pages`, `upload_files` and `manage_options` are present, depending on what the agent will do.
- 401 `rest_not_logged_in` usually means the Authorization header was stripped (see below).
- 401 `incorrect_password` means a wrong password, or that Application Passwords are disabled for this user.

### Required capabilities per action
| Action | Capability |
|---|---|
| Update any post or page | `edit_others_posts` / `edit_others_pages`, plus `edit_published_*` and `publish_*` |
| Media alt text | `upload_files` + `edit_post` on the attachment |
| Yoast REST meta / ability | `edit_post`; `wpseo_edit_advanced_metadata` for canonical and noindex; `wpseo_manage_options` for the bulk route |
| Rank Math `updateMeta` | `edit_post` (or `edit_others_posts`) on that post; for homepage (`objectID=0`) the Rank Math "titles" cap |
| Rank Math redirections | Redirections module active + Rank Math `redirections` cap |
| Redirection plugin | `manage_options` by default (`redirection_role` filter) |
| SEOPress REST | `edit_post`, and the metabox role must not be blocked |
| AIOSEO | `aioseo_page_general_settings` (admins have it) + `edit_post` |
| Companion mu-plugin | whatever you code. Suggested: `edit_post` for meta, `manage_options` for site-wide |

The simplest setup is a dedicated **Administrator** user named `seo-agent`, with its own Application Password, so actions are auditable and the password can be revoked.

### Common blocks (and fixes)
- **Authorization header stripped** (Apache CGI/FastCGI, some shared hosts). Per the REST API FAQ:
  ```apache
  # .htaccess (above the WordPress block)
  <IfModule mod_setenvif.c>
    SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1
  </IfModule>
  # or
  RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
  ```
  For nginx/php-fpm, use `fastcgi_pass_header Authorization;` (or `fastcgi_param HTTP_AUTHORIZATION $http_authorization;`).
- **Security plugins:**
  - Wordfence ("Disable application passwords" option, login-security 2FA)
  - Solid/iThemes Security ("Restrict REST API" / disable app passwords)
  - "Disable REST API" style plugins that return 401 `rest_cannot_access` for non-logged-in users. With app passwords the user *is* logged in, so the request usually passes.
  - All-in-One WP Security
  - Cloudflare WAF / Bot Fight Mode / Super Bot Fight Mode. These block non-browser user agents and return 403 HTML instead of JSON. Allowlist the agent's IP or user agent, or add a WAF skip rule for `/wp-json/*` with the agent's header.
- **Staging behind htpasswd:** the site-level Basic auth collides with Application Passwords, because there is only one Authorization header. Use an IP allowlist for staging instead.
- **Permalinks set to "Plain":** `/wp-json/` is not routed. Always fall back to `?rest_route=/wp/v2/...`.
- **nginx query args lost:** use `try_files $uri $uri/ /index.php$is_args$args;`.

### REST discovery
- Every front-end page sends `Link: <https://site/wp-json/>; rel="https://api.w.org/"` (HTTP header) and a matching `<link rel="https://api.w.org/">` tag. Use this rather than assuming `/wp-json/`, because subdirectory installs and custom prefixes exist.
- `HEAD https://site/` → parse the `Link` header. Then `GET <root>` → `namespaces[]` tells you which plugins are present: `yoast/v1`, `rankmath/v1`, `seopress/v1`, `aioseo/v1`, `redirection/v1`, `wp-abilities/v1`, and your own `seo-agent/v1`.
- Singular pages also send `Link: <…/wp-json/wp/v2/posts/123>; rel="alternate"; type="application/json"`. This is the cheapest **URL → post ID** mapping (see 2.4).

---

## 2. Core content

### 2.1 Update a post or page
```
POST /wp-json/wp/v2/posts/<id>      (pages: /wp/v2/pages/<id>; CPT: /wp/v2/<rest_base>/<id>)
Content-Type: application/json
{ "title": "New H1/post title",
  "slug": "new-slug",
  "content": "<!-- wp:paragraph --><p>…</p><!-- /wp:paragraph -->",
  "excerpt": "Short summary",
  "featured_media": 456,
  "meta": { "some_registered_key": "value" } }
```
- `PUT` and `PATCH` are also accepted (`WP_REST_Server::EDITABLE`).
- Read the current state with `GET …/<id>?context=edit`. That returns `title.raw` and `content.raw` (block markup). Always edit **raw**, never `rendered`.
- `content` replaces the whole post body. To change one heading or paragraph, fetch `content.raw`, patch the markup in place and send everything back. Keep the block comments (`<!-- wp:… -->`) intact, or the editor shows "block contains unexpected content".
- **Page builders** (Elementor, Divi, WPBakery, Bricks) store layout in their own meta, for example `_elementor_data` JSON. Editing `content` on those pages has no visible effect. Detect `meta._elementor_edit_mode==='builder'` (or the `_elementor_data` key via the companion plugin) and treat the page as "needs human / builder-specific handler".
- **Slug change:** WP stores the old slug in `_wp_old_slug` and core's `wp_old_slug_redirect` makes the old URL redirect (301) for posts. That is not reliable for pages and hierarchical types, so always create an explicit 301 (section 4). For posts that are not published, `slug` may come back empty until publish.
- `featured_media` takes an attachment ID. `0` removes it.
- Status codes: `rest_cannot_edit` 403, `rest_post_invalid_id` 404.

### 2.2 Media alt text
```
POST /wp-json/wp/v2/media/<attachment_id>
{ "alt_text": "Descriptive alt", "caption": "…", "title": "…", "description": "…" }
```
- `alt_text` is stored in `_wp_attachment_image_alt`.
- **Gotcha:** in block content, `<img alt="…">` is **baked into the post HTML** when the image is inserted. Changing the attachment's `alt_text` does **not** change existing posts. To fix the alt on a specific page, edit `content.raw` (the `alt` attribute inside `wp:image`). Also update `alt_text` so future inserts get it.
- To find attachments, use `GET /wp/v2/media?search=<filename>&media_type=image&_fields=id,source_url,alt_text`. Use `parent=<post_id>` for attachments uploaded to a specific post.

### 2.3 Find a post by URL
In order of reliability:
1. `HEAD/GET <url>` and read the `Link: <…/wp/v2/(posts|pages|cpt)/<id>>; rel="alternate"` header (WP 5.5+). This works for any public singular page and also follows hierarchy.
2. Take the last path segment and query `GET /wp/v2/posts?slug=<seg>&status=any&_fields=id,link,type` (needs auth for `status=any`), then `/wp/v2/pages?slug=…`, then each CPT from `GET /wp/v2/types`. **Match `link` exactly** against the canonical URL, because slugs are unique per type and parent, not globally.
3. Use `GET /seopress/v1/posts/by-url?url=…` if SEOPress is present, the Yoast `get-post-seo-data` ability which accepts `permalink`, or the companion route `GET /seo-agent/v1/resolve?url=…` (uses `url_to_postid()`).
4. As a last resort, use `GET /wp/v2/search?search=<term>&type=post&subtype=any`.

Homepage: if `GET /wp/v2/settings` shows `show_on_front=page`, the front page is `page_on_front`. If it is `posts`, there is no post object, and SEO meta lives in plugin options (Rank Math `objectID:0`, Yoast settings).

### 2.4 Revisions and rollback
- **Core routes:**
  - `GET /wp/v2/posts/<parent>/revisions`
  - `GET /wp/v2/posts/<parent>/revisions/<id>`
  - `DELETE /wp/v2/posts/<parent>/revisions/<id>?force=true`
  - The same routes exist for pages.
  - Permission is `edit_post` on the parent.
  - `GET /wp/v2/posts/<id>/autosaves` also exists.
- **There is no "restore" REST endpoint.** To roll back, GET the revision (`title.raw`, `content.raw`, `excerpt.raw` with `context=edit`) and re-POST those values to the parent. That creates a new revision, so history is preserved.
- Revisions capture title, content and excerpt only. Since WP 6.4, meta registered with `revisions_enabled => true` is also captured (the post type must support `revisions` and `custom-fields`). Yoast, Rank Math and other SEO meta are **not** revisioned. Slug, featured image and media alt text are **not** in revisions either.
- Revisions may be disabled (`WP_POST_REVISIONS=false`) or capped.
- **Recommended rollback strategy:**
  1. Before applying change *C* to object *O*, write a **change record**: `{change_id, site, object_type, object_id, url, field_path, old_value, new_value, method(endpoint+payload), applied_at, applied_by, approval_id, revision_id_after}`.
  2. Read `old_value` with exactly the same channel you will write with, for example `GET /seo-agent/v1/meta/<id>`.
  3. Apply. Verify the read-back equals `new_value`, then verify the live page.
  4. **Rollback** means replaying the same endpoint with `old_value`. An empty or absent old value means delete the meta: send `""` or `null`. All the plugin endpoints below treat empty as "delete/fall back to default".
  5. Content edits should also store the core `revision_id` created by the write, as a second safety net.
  6. Redirects store the created redirect ID. To roll back, delete or disable it.
  7. Optionally, store snapshots in the companion plugin itself (an `_seo_agent_snapshot` option keyed by change ID) so a site admin can undo without the agent.

---

## 3. SEO plugin fields

### 3.1 Yoast SEO (28.6)
**Meta keys** (post meta, prefixed `_yoast_wpseo_`):

| Field | Meta key / values |
|---|---|
| SEO title | `_yoast_wpseo_title` |
| Meta description | `_yoast_wpseo_metadesc` |
| Focus keyphrase | `_yoast_wpseo_focuskw` |
| Canonical | `_yoast_wpseo_canonical` |
| Noindex | `_yoast_wpseo_meta-robots-noindex`: `'0'` = type default, `'1'` = noindex, `'2'` = index |
| Nofollow | `_yoast_wpseo_meta-robots-nofollow`: `'0'` / `'1'` |
| Advanced robots | `_yoast_wpseo_meta-robots-adv`: CSV of `noimageindex,noarchive,nosnippet` |
| Breadcrumb title | `_yoast_wpseo_bctitle` |
| Open Graph | `_yoast_wpseo_opengraph-title`, `-description`, `-image`, `-image-id` |
| Twitter | `_yoast_wpseo_twitter-title`, `_yoast_wpseo_twitter-description`, … |
| Schema types | `_yoast_wpseo_schema_page_type`, `_yoast_wpseo_schema_article_type` |
| Redirect | `_yoast_wpseo_redirect` (Premium only) |

**Is it writable via REST?**
- **Partly.** Current Yoast registers `title`, `metadesc` and `focuskw` with `show_in_rest` and an `edit_post` auth callback, **but only for the `post` subtype** (`object_subtype => 'post'`). So:
  - On `/wp/v2/posts/<id>`, `{"meta":{"_yoast_wpseo_title":"…","_yoast_wpseo_metadesc":"…"}}` works.
  - On **pages and CPTs** these keys are not in `meta` and are silently ignored.
  - Canonical and robots keys are **never** REST-exposed.
  - Older Yoast versions exposed nothing.
- `yoast_head` / `yoast_head_json` (REST fields on every post, term and user) are **read-only** output. They are useful for verification, not writing. There is also `GET /wp-json/yoast/v1/get_head?url=<url>`, which returns head JSON for any URL. It is great for verifying non-singular URLs.
- **Abilities API (WP ≥ 6.9, Yoast 28.x):**
  - `GET  /wp-json/wp-abilities/v1/abilities/yoast-seo/get-post-seo-data/run?input[post_id]=123` (read-only abilities use GET)
  - `POST /wp-json/wp-abilities/v1/abilities/yoast-seo/update-post-seo-data/run` with body
    `{"input":{"post_id":123,"canonical":"https://…","noindex":true,"nofollow":false,"noarchive":false,"nosnippet":false,"noimageindex":false,"is_cornerstone":false,"schema_page_type":"FAQPage","schema_article_type":null}}`
    You can pass `permalink` instead of `post_id`. Fields you leave out are unchanged. `null` or `""` clears a field.
  - Permission: `wpseo_edit_advanced_metadata`.
  - Note that this ability covers **canonical, robots, cornerstone and schema types, but not title or description**.
  - List what exists with `GET /wp-json/wp-abilities/v1/abilities?category=yoast-seo`.
- **Bulk editor route** (title, description and keyphrase for any post type, up to **20 items** per call):
  ```
  POST /wp-json/yoast/v1/bulk_editor/update_search
  {"items":[{"id":123,"seo_title":"…","meta_description":"…","focus_keyphrase":"…"}]}
  ```
  - Permission: `wpseo_manage_options` (admin). `""` clears a field.
  - `/bulk_editor/update_social` does the same for OG and Twitter (`og_title`, …).
  - This route is internal to the Yoast admin UI and newer than most docs, so feature-detect it from `GET /wp-json/yoast/v1` and keep a fallback.
- **Gotchas:**
  - Yoast's `remove_meta_if_default` deletes the meta when the value equals the default.
  - Yoast caches output in **indexables** (`wp_yoast_indexable`). A meta write through `update_post_meta` triggers its `updated_post_meta` watcher, but direct DB writes don't. After odd results, re-save the post (`POST /wp/v2/posts/<id>` with `{}`) to rebuild the indexable.
  - Title templates use `%%title%% %%sep%% %%sitename%%` variables. Store them literally.

### 3.2 Rank Math (1.0.279)
**Meta keys** (no underscore, so not "protected" meta):

| Field | Meta key / values |
|---|---|
| Title | `rank_math_title` |
| Description | `rank_math_description` |
| Focus keyword | `rank_math_focus_keyword` (comma-separated; the first is primary) |
| Canonical | `rank_math_canonical_url` |
| Robots | `rank_math_robots`: **serialized array**, e.g. `["noindex","nofollow"]` or `["index","follow"]` |
| Advanced robots | `rank_math_advanced_robots`: array, e.g. `{"max-snippet":"-1","max-image-preview":"large"}` |
| Pillar content | `rank_math_pillar_content` = `'on'` |
| Social | `rank_math_facebook_title`, `rank_math_twitter_*` |
| Schema | `rank_math_schema_<Type>` (JSON array) |

None of these are registered with `show_in_rest`, so `/wp/v2` `meta` does not work.

**Native REST route** (used by Rank Math's own editor):
```
POST /wp-json/rankmath/v1/updateMeta
{ "objectType": "post",            // post | term | user
  "objectID": 123,                 // 0 = homepage settings (needs titles cap)
  "meta": { "rank_math_title": "…",
            "rank_math_description": "…",
            "rank_math_focus_keyword": "kw1,kw2",
            "rank_math_canonical_url": "https://…",
            "rank_math_robots": ["noindex","follow"],
            "permalink": "new-slug" } }      // optional: changes post_name
```
- Permission: `edit_post` on that object (or `edit_others_posts`). The post type must be "accessible" in Rank Math settings.
- **Empty value means delete** the meta.
- Only `rank_math_*` keys are writable (enforced through `is_protected_meta`).
- Values go through `Sanitize::sanitize` (`esc_url_raw` for canonical, kses for text).
- Returns `{slug, schemas}`.
- Schema writes go through `POST /rankmath/v1/updateSchemas` (`objectID`, `objectType`, `schemas:{ "new-1": {...@type...} }`).
- Rank Math also registers Abilities (`rank-math/get-post-seo-meta`, `rank-math/get-robots-txt`, `rank-math/get-llms-txt`, `rank-math/get-redirections`, `rank-math/set-homepage-seo`, `rank-math/fix-site-seo`, …). The per-post *write* still goes through `updateMeta`.
- Rank Math uses REST nonces in its UI, but Application-Password auth satisfies `permission_callback` without a nonce.

### 3.3 SEOPress (10.3)
- **REST-registered meta:** SEOPress registers its keys with `show_in_rest => true` for **all post types**, with an auth callback. So `/wp/v2/<type>/<id>` with `meta` works:
  - `_seopress_titles_title`, `_seopress_titles_desc`
  - `_seopress_robots_index` (`'yes'` = noindex), `_seopress_robots_follow` (`'yes'` = nofollow)
  - `_seopress_robots_canonical`
  - `_seopress_analysis_target_kw`
  - `_seopress_social_*`
  - `_seopress_redirections_*`
- **Dedicated routes:**
  - `GET|PUT /seopress/v1/posts/<id>/title-description-metas` with `{"title":"…","description":"…"}` (empty means delete)
  - `GET|PUT /seopress/v1/posts/<id>/meta-robot-settings` with `{"_seopress_robots_index":"yes","_seopress_robots_canonical":"https://…"}`
  - `/seopress/v1/posts/<id>/social-settings`
  - `/seopress/v1/posts/<id>/redirection-settings`
  - `GET /seopress/v1/posts/by-url?url=…`
  - Permission: `edit_post`.
- **Abilities:** `seopress/update-post-title-description`, `seopress/update-post-robots-settings`, … These are exposed over REST **only when the admin enables** the "Abilities API REST" option (`seopress_advanced_abilities_api_rest`).

### 3.4 AIOSEO (5.0.2.1)
- Data is stored in the **custom table `wp_aioseo_posts`**, not in post meta, so `meta` and `register_post_meta` won't work.
- **Abilities (WP 6.9+):** `POST /wp-json/wp-abilities/v1/abilities/aioseo-posts/seo-data-update/run`
  `{"input":{"postId":123,"title":"…","description":"…","canonical_url":"…","focus_keyphrase":"…","robots":{"use_default":false,"noindex":true,"nofollow":false}}}`
  - Fields you leave out are kept; `null` clears a field.
  - Read with `aioseo-posts/seo-data-get` (GET).
  - Robots.txt: `aioseo-robots/rules-add|update|delete`.
- **Internal route:** `POST /wp-json/aioseo/v1/post` with `{"id":123,"title":"…","description":"…",…}`. Permission: `aioseo_page_general_settings` + `edit_post`.

### 3.5 Most reliable cross-plugin approach
Ship a **companion mu-plugin** (section 7):
- It detects the active SEO plugin.
- It exposes **one normalized schema**: `seo_title`, `meta_description`, `focus_keyword`, `canonical`, `noindex`, `nofollow`, `json_ld`, `og_title`, `og_description`.
- It reads and writes through the plugin's own PHP storage. For AIOSEO it calls the Abilities API in-process or the AIOSEO model.
- It registers raw meta keys with `show_in_rest` and an `edit_post` auth callback for **all** post types, so `/wp/v2` works too.

This removes per-version REST drift. Abilities and internal routes appear and change between releases, and Yoast exposes keys only for `post`.

---

## 4. Redirects (301)

### Redirection plugin (`redirection/v1`)
```
POST /wp-json/redirection/v1/redirect
{ "url": "/old-path/",                 // source (relative); may be an array to create several
  "match_url": "/old-path",            // optional
  "match_data": {"source":{"flag_query":"exact","flag_case":false,"flag_trailing":true,"flag_regex":false}},
  "action_type": "url",
  "action_code": 301,
  "action_data": {"url": "/new-path/"},
  "match_type": "url",
  "group_id": 1,                       // REQUIRED to be a real group; GET /redirection/v1/group to find it
  "regex": false,
  "title": "seo-agent change 8f3a" }
```
- Other routes:
  - `GET /redirection/v1/redirect?filterBy[url]=/old-path/` to check for an existing redirect first (avoid duplicates and chains).
  - `POST /redirection/v1/redirect/<id>` to update.
  - `POST /redirection/v1/bulk/redirect/delete|enable|disable` with `{"items":[id]}` for rollback.
  - `GET /redirection/v1/group` lists groups. On a new install, "Redirections" is usually ID 1, but don't assume it.
- Permission: `manage_options` by default. It is adjustable through `redirection_role` / `redirection_capability_check`.
- Rank Math's redirect module and Redirection can both be active, which causes conflicts. Pick one and detect it.

### Rank Math redirections
- **Per post:** `POST /wp-json/rankmath/v1/updateRedirection`
  `{"objectType":"post","objectID":123,"hasRedirect":true,"redirectionUrl":"https://site/new/","redirectionType":"301","redirectionSources":"https://site/old/"}`
  - It needs the Redirections module active and the `redirections` cap.
  - Types: 301, 302, 307, 410, 451.
  - Send `redirectionID` to update an existing redirect.
- There is no public REST route for **arbitrary** (non-post) redirects. Use the companion plugin, which calls `\RankMath\Redirections\Redirection::from(['url_to'=>…,'header_code'=>301])->add_source($from,'exact')->save()` (sketched in section 7).

### Others
- SEOPress: `PUT /seopress/v1/posts/<id>/redirection-settings` (redirect *from this post*). The site-wide 301 manager is Pro.
- Yoast: redirects are Premium only (`_yoast_wpseo_redirect` meta, and the redirects option `wpseo-premium-redirects-base`). There is no public REST route; use the Redirection plugin or the companion plugin.
- Without any redirect plugin, the companion plugin keeps its own map in an option and hooks `template_redirect` (section 7).

---

## 5. Schema / JSON-LD, robots.txt, llms.txt

### Per-page JSON-LD
The best approach is a companion meta key `_seo_agent_jsonld` (a JSON string or array of graphs) registered with `show_in_rest`. It is printed in `wp_head` as `<script type="application/ld+json">`. Notes:
- Validate it with `json_decode` before saving, and output it with `wp_json_encode($data, JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE|JSON_HEX_TAG)` to prevent `</script>` injection.
- **Avoid duplicates.** Yoast, Rank Math and AIOSEO already print a `@graph`. Either:
  - (a) add only *additional* types such as FAQPage, HowTo, Product or LocalBusiness, using `@id` to link to the plugin's `#webpage`, or
  - (b) hook into the plugin graph:
    - Yoast: `wpseo_schema_graph` filter
    - Rank Math: `rank_math/json_ld` filter
    - SEOPress: `seopress_schemas_auto_*`
  
  Option (b) is cleaner for Google, which doesn't require a single graph but prefers one consistent `@id` web.
- Rank Math native: `POST /rankmath/v1/updateSchemas`. Yoast native: only `schema_page_type` / `schema_article_type` through the ability.

### robots.txt
- If a **physical `robots.txt`** exists in the web root, WP filters are bypassed. Detect this by checking whether the response contains WP's `# START YOAST` / `Sitemap:` markers, or have the companion check `file_exists(ABSPATH.'robots.txt')`.
- Virtual robots.txt (core `do_robots`) can be changed through the **`robots_txt` filter** `( $output, $public )`. The companion stores the agent's content in an option and returns it. Note:
  - Rank Math, when its editor has content, also hooks `robots_txt` at priority 10. Run the companion at priority 99 so it wins, or write into Rank Math's setting (`rank-math-options-general['robots_txt_content']`).
  - Yoast's robots editor (Tools → File editor) writes a **physical file**. Yoast's `wpseo_robots_txt` hooks are for its generated block.
  - AIOSEO: use the `aioseo-robots/rules-*` abilities.
- If `blog_public=0`, WP outputs `Disallow: /`. Check `GET /wp/v2/settings` (admin only), or `<meta name="robots" content="noindex">` on the home page, before anything else.

### llms.txt
- Rank Math has an `llms` module that serves `/llms.txt` through a rewrite rule (settings under General → llms.txt). Yoast 25+ can generate `llms.txt` as a physical file (Site features → llms.txt).
- The companion approach is an option `seo_agent_llms_txt` served at `/llms.txt` via a `parse_request` check. This works without flushing rewrites and is skipped if a physical file or another plugin serves it.

---

## 6. Rate limits, caching, verification

### Rate limits
- Core WP has no REST rate limit. The limits come from hosts, WAFs (Cloudflare, Sucuri, Wordfence's rate limiting, which counts REST hits) and PHP workers.
- Be gentle: **≤ 2 to 4 concurrent requests and ~1 to 2 requests per second**.
- Back off on 429, 503 and 403-with-HTML (that indicates a WAF challenge). Use `per_page=100` and `_fields=` to cut payload size.
- Yoast bulk is capped at 20 items. Cloudflare purge allows 100 URLs per call (500 on Enterprise) and uses a token bucket (Free: 5 requests per minute, burst 25).

### Cache purge (after every successful write)
The companion `POST /seo-agent/v1/purge {"post_id":123,"urls":[…]}` runs these in-process:
```php
clean_post_cache($id);                                  // WP object cache
if (function_exists('rocket_clean_post')) rocket_clean_post($id);          // WP Rocket
if (function_exists('rocket_clean_files')) rocket_clean_files($urls);       // WP Rocket by URL
do_action('litespeed_purge_post', $id);                 // LiteSpeed Cache
foreach ($urls as $u) do_action('litespeed_purge_url', $u);
if (function_exists('w3tc_flush_post')) w3tc_flush_post($id);              // W3TC
if (function_exists('wp_cache_post_change')) wp_cache_post_change($id);     // WP Super Cache
if (class_exists('\SiteGround_Optimizer\Supercacher\Supercacher')) do_action('siteground_optimizer_flush_cache');
do_action('cloudflare_purge_by_url', $urls);            // official Cloudflare WP plugin listens on save_post; this is a no-op hook if absent
if (function_exists('wpe_purge_cache_by_post')) ...;    // host specific (WP Engine: WpeCommon::purge_varnish_cache($id))
```
Then purge the **CDN directly** if the agent holds a Cloudflare token (`Zone.Cache Purge` permission):
```
POST https://api.cloudflare.com/client/v4/zones/{zone_id}/purge_cache
Authorization: Bearer <token>
{"files":["https://site/page/","https://site/page"]}       # ≤100 per call; or {"prefixes":[…]}, {"tags":[…]}, {"purge_everything":true}
```
Purge both the trailing-slash and non-slash variants, and include the old URL after a slug change. Purging a URL that returns 301 clears only the cached redirect.

Also purge (or regenerate) related surfaces:
- the sitemap (`/sitemap_index.xml`). Yoast and Rank Math cache sitemaps in transients that are invalidated on save.
- category and archive pages, if the title or excerpt shows up there.

### Verify the live page
1. Wait about 2 to 5 seconds after purging.
2. `GET <url>?seo_agent_verify=<random>` with `Cache-Control: no-cache` and a normal browser UA. The query string misses page caches. Afterwards, also fetch the clean URL to prove the purge worked.
3. Check response headers: `cf-cache-status` (want MISS/DYNAMIC/EXPIRED after purge), `x-litespeed-cache`, `x-cache`, `age`.
4. Parse the head:
   - `<title>`
   - `meta[name=description]`
   - `link[rel=canonical]`
   - `meta[name=robots]`
   - `og:*`
   - every `script[type="application/ld+json"]` (parse the JSON)
   - `h1`
   - `img[alt]`
5. Compare the normalized values (decode entities and collapse whitespace) with `new_value`. On mismatch, mark the change as "applied but not live", retry the purge once, then flag it.
6. Cross-check, cache-free:
   - `GET /wp/v2/posts/<id>?_fields=yoast_head_json`
   - `GET /yoast/v1/get_head?url=…`
   - `GET /seo-agent/v1/meta/<id>`

   These show what WP *would* render. If they match but the HTML doesn't, the problem is cache, not data.
7. 301 checks: `curl -sI old` should show `301` plus `Location: new`. Make sure there is no chain (`new` returns 200) and no loop.

---

## 7. Companion mu-plugin (recommended)

Save as `wp-content/mu-plugins/seo-agent-bridge.php`. MU-plugins load automatically and can't be deactivated from the UI. The site owner uploads it once via SFTP or a host file manager, or installs a regular-plugin copy through `POST /wp/v2/plugins` (that needs `install_plugins`, and only works for wordpress.org slugs).

```php
<?php
/**
 * Plugin Name: SEO Agent Bridge
 * Description: Normalized, authenticated REST surface for an external SEO agent (meta, JSON-LD, redirects, robots/llms.txt, cache purge, snapshots).
 * Version: 1.0.0
 */
defined('ABSPATH') || exit;

final class SEO_Agent_Bridge {
    const NS = 'seo-agent/v1';
    const JSONLD = '_seo_agent_jsonld';

    public static function init() {
        add_action('init', [__CLASS__, 'register_meta'], 99);
        add_action('rest_api_init', [__CLASS__, 'routes']);
        add_action('wp_head', [__CLASS__, 'print_jsonld'], 99);
        add_filter('robots_txt', [__CLASS__, 'robots_txt'], 99, 2);
        add_action('parse_request', [__CLASS__, 'llms_txt'], 0);
        add_action('template_redirect', [__CLASS__, 'redirects'], 0);
    }

    /* ---------- plugin detection & key map ---------- */
    public static function plugin() {
        if (defined('WPSEO_VERSION'))            return 'yoast';
        if (class_exists('RankMath'))            return 'rankmath';
        if (defined('SEOPRESS_VERSION'))         return 'seopress';
        if (function_exists('aioseo'))           return 'aioseo';
        return 'none';
    }
    public static function map($p = null) {
        $p = $p ?: self::plugin();
        $maps = [
          'yoast'    => ['seo_title'=>'_yoast_wpseo_title','meta_description'=>'_yoast_wpseo_metadesc','focus_keyword'=>'_yoast_wpseo_focuskw','canonical'=>'_yoast_wpseo_canonical','noindex'=>'_yoast_wpseo_meta-robots-noindex','nofollow'=>'_yoast_wpseo_meta-robots-nofollow','og_title'=>'_yoast_wpseo_opengraph-title','og_description'=>'_yoast_wpseo_opengraph-description'],
          'rankmath' => ['seo_title'=>'rank_math_title','meta_description'=>'rank_math_description','focus_keyword'=>'rank_math_focus_keyword','canonical'=>'rank_math_canonical_url','robots'=>'rank_math_robots','og_title'=>'rank_math_facebook_title','og_description'=>'rank_math_facebook_description'],
          'seopress' => ['seo_title'=>'_seopress_titles_title','meta_description'=>'_seopress_titles_desc','focus_keyword'=>'_seopress_analysis_target_kw','canonical'=>'_seopress_robots_canonical','noindex'=>'_seopress_robots_index','nofollow'=>'_seopress_robots_follow','og_title'=>'_seopress_social_fb_title','og_description'=>'_seopress_social_fb_desc'],
          'none'     => ['seo_title'=>'_seo_agent_title','meta_description'=>'_seo_agent_desc','canonical'=>'_seo_agent_canonical','noindex'=>'_seo_agent_noindex'],
        ];
        return $maps[$p] ?? [];
    }

    /* ---------- expose raw keys on /wp/v2/<type> for every post type ---------- */
    public static function register_meta() {
        $keys = array_values(self::map());
        $keys[] = self::JSONLD;
        foreach (get_post_types(['public' => true]) as $pt) {
            foreach ($keys as $k) {
                $is_array = ($k === 'rank_math_robots');
                register_post_meta($pt, $k, [
                    'single'        => true,
                    'type'          => $is_array ? 'array' : 'string',
                    'show_in_rest'  => $is_array ? ['schema' => ['type'=>'array','items'=>['type'=>'string']]] : true,
                    'auth_callback' => function ($allowed, $key, $post_id) { return current_user_can('edit_post', $post_id); },
                ]);
            }
        }
    }

    /* ---------- REST ---------- */
    public static function routes() {
        $can_edit = function ($r) { return current_user_can('edit_post', (int) $r['id']); };
        $admin    = function () { return current_user_can('manage_options'); };

        register_rest_route(self::NS, '/info', ['methods'=>'GET','permission_callback'=>$admin,'callback'=>function () {
            return ['plugin'=>self::plugin(),'wp'=>get_bloginfo('version'),'blog_public'=>(int)get_option('blog_public'),
                    'physical_robots'=>file_exists(ABSPATH.'robots.txt'),'physical_llms'=>file_exists(ABSPATH.'llms.txt'),
                    'fields'=>array_keys(self::map())];
        }]);

        register_rest_route(self::NS, '/resolve', ['methods'=>'GET','permission_callback'=>$admin,'callback'=>function ($r) {
            $id = url_to_postid(esc_url_raw($r['url']));
            return ['id'=>$id,'type'=>$id ? get_post_type($id) : null,'link'=>$id ? get_permalink($id) : null];
        }]);

        register_rest_route(self::NS, '/meta/(?P<id>\d+)', [
          ['methods'=>'GET','permission_callback'=>$can_edit,'callback'=>function ($r) { return self::read((int)$r['id']); }],
          ['methods'=>'POST','permission_callback'=>$can_edit,'callback'=>function ($r) {
              $id = (int) $r['id']; $before = self::read($id);
              $res = self::write($id, (array) $r->get_json_params());
              if (is_wp_error($res)) return $res;
              self::purge($id);
              return ['before'=>$before,'after'=>self::read($id)];   // caller stores "before" for rollback
          }],
        ]);

        register_rest_route(self::NS, '/redirect', ['methods'=>'POST','permission_callback'=>$admin,'callback'=>function ($r) {
            $from = '/'.ltrim(wp_parse_url($r['from'], PHP_URL_PATH) ?: '', '/');
            $to   = esc_url_raw($r['to']); $code = in_array((int)$r['code'], [301,302,307,410], true) ? (int)$r['code'] : 301;
            if ($from === '/' || !$to && $code !== 410) return new WP_Error('bad_redirect', 'from/to required', ['status'=>400]);
            $map = get_option('seo_agent_redirects', []);
            if ($r['delete']) unset($map[$from]); else $map[$from] = ['to'=>$to,'code'=>$code];
            update_option('seo_agent_redirects', $map, true);
            return ['from'=>$from,'rule'=>$map[$from] ?? null];
        }]);

        register_rest_route(self::NS, '/(?P<file>robots|llms)', [
          ['methods'=>'GET','permission_callback'=>$admin,'callback'=>function ($r) { return ['content'=>(string) get_option('seo_agent_'.$r['file'].'_txt', '')]; }],
          ['methods'=>'POST','permission_callback'=>$admin,'callback'=>function ($r) {
              $key = 'seo_agent_'.$r['file'].'_txt'; $before = (string) get_option($key, '');
              update_option($key, sanitize_textarea_field((string) $r['content']), false);
              return ['before'=>$before,'after'=>get_option($key)];
          }],
        ]);

        register_rest_route(self::NS, '/purge', ['methods'=>'POST','permission_callback'=>$admin,'callback'=>function ($r) {
            self::purge((int) $r['post_id'], (array) ($r['urls'] ?? []));
            return ['ok'=>true];
        }]);
    }

    /* ---------- normalized read/write ---------- */
    public static function read($id) {
        $out = ['plugin'=>self::plugin()];
        if (self::plugin() === 'aioseo') {
            $a = self::aioseo_run('aioseo-posts/seo-data-get', ['postId'=>$id], 'GET');
            $out['raw'] = $a;
        } else {
            foreach (self::map() as $field => $key) $out[$field] = get_post_meta($id, $key, true);
        }
        $out['json_ld'] = get_post_meta($id, self::JSONLD, true);
        return $out;
    }

    public static function write($id, array $in) {
        $p = self::plugin(); $map = self::map();
        if (array_key_exists('json_ld', $in)) {
            if ($in['json_ld'] === '' || $in['json_ld'] === null) delete_post_meta($id, self::JSONLD);
            else {
                $json = is_string($in['json_ld']) ? json_decode($in['json_ld'], true) : $in['json_ld'];
                if (!is_array($json)) return new WP_Error('bad_jsonld', 'json_ld must be valid JSON', ['status'=>400]);
                update_post_meta($id, self::JSONLD, wp_slash(wp_json_encode($json, JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE)));
            }
        }
        if ($p === 'aioseo') {
            $input = ['postId'=>$id];
            foreach (['seo_title'=>'title','meta_description'=>'description','canonical'=>'canonical_url','focus_keyword'=>'focus_keyphrase'] as $f=>$k)
                if (array_key_exists($f, $in)) $input[$k] = $in[$f] === '' ? null : $in[$f];
            if (isset($in['noindex']) || isset($in['nofollow']))
                $input['robots'] = ['use_default'=>false,'noindex'=>!empty($in['noindex']),'nofollow'=>!empty($in['nofollow'])];
            $r = self::aioseo_run('aioseo-posts/seo-data-update', $input, 'POST');
            return is_wp_error($r) ? $r : true;
        }
        foreach ($in as $field => $val) {
            if ($field === 'json_ld') continue;
            if (in_array($field, ['noindex','nofollow'], true)) {
                $val = (bool) $val;
                if ($p === 'yoast')    { update_post_meta($id, $map[$field], $val ? '1' : '0'); continue; }
                if ($p === 'seopress') { $val ? update_post_meta($id, $map[$field], 'yes') : delete_post_meta($id, $map[$field]); continue; }
                if ($p === 'rankmath') {
                    $rob = (array) get_post_meta($id, 'rank_math_robots', true);
                    $rob = array_values(array_diff($rob, $field === 'noindex' ? ['index','noindex'] : ['follow','nofollow']));
                    $rob[] = $field === 'noindex' ? ($val ? 'noindex' : 'index') : ($val ? 'nofollow' : 'follow');
                    update_post_meta($id, 'rank_math_robots', $rob); continue;
                }
                if ($p === 'none' && $field === 'noindex') { $val ? update_post_meta($id, $map['noindex'], '1') : delete_post_meta($id, $map['noindex']); }
                continue;
            }
            if (!isset($map[$field])) continue;
            $val = $field === 'canonical' ? esc_url_raw((string) $val) : sanitize_text_field((string) $val);
            if ($val === '') delete_post_meta($id, $map[$field]);
            else update_post_meta($id, $map[$field], wp_slash($val));
        }
        // Touch the post so plugin indexables / caches rebuild (Yoast indexables, sitemaps).
        do_action('save_post', $id, get_post($id), true);
        return true;
    }

    private static function aioseo_run($name, $input, $method) {
        if (!function_exists('wp_get_ability') || !($ab = wp_get_ability($name))) return new WP_Error('no_ability', "$name unavailable");
        return $ab->execute($input);
    }

    /* ---------- front-end output ---------- */
    public static function print_jsonld() {
        if (!is_singular()) return;
        $raw = get_post_meta(get_queried_object_id(), self::JSONLD, true);
        $data = $raw ? json_decode($raw, true) : null;
        if (!$data) return;
        foreach ((isset($data['@context']) || isset($data['@graph'])) ? [$data] : (array) $data as $g) {
            echo "\n<script type=\"application/ld+json\" class=\"seo-agent-schema\">"
               . wp_json_encode($g, JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE|JSON_HEX_TAG|JSON_HEX_AMP)
               . "</script>\n";
        }
        if (self::plugin() === 'none') {           // minimal head output when no SEO plugin is present
            $id = get_queried_object_id();
            if ($d = get_post_meta($id, '_seo_agent_desc', true)) echo '<meta name="description" content="'.esc_attr($d)."\" />\n";
            if (get_post_meta($id, '_seo_agent_noindex', true)) echo "<meta name=\"robots\" content=\"noindex\" />\n";
        }
    }

    public static function robots_txt($output, $public) {
        $custom = (string) get_option('seo_agent_robots_txt', '');
        return ($custom !== '' && $public) ? $custom : $output;
    }

    public static function llms_txt($wp) {
        if (untrailingslashit($wp->request) !== 'llms.txt') return;
        $c = (string) get_option('seo_agent_llms_txt', '');
        if ($c === '') return;                           // let Rank Math/Yoast/physical file handle it
        header('Content-Type: text/plain; charset=utf-8');
        echo $c; exit;
    }

    public static function redirects() {
        $map = get_option('seo_agent_redirects', []);
        if (!$map) return;
        $path = '/'.ltrim((string) wp_parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH), '/');
        foreach ([$path, trailingslashit($path), untrailingslashit($path)] as $p) {
            if (isset($map[$p])) {
                if ((int) $map[$p]['code'] === 410) { status_header(410); nocache_headers(); exit; }
                wp_redirect($map[$p]['to'], (int) $map[$p]['code'], 'SEO Agent'); exit;
            }
        }
    }

    /* ---------- cache purge ---------- */
    public static function purge($id = 0, array $urls = []) {
        if ($id) { clean_post_cache($id); $urls[] = get_permalink($id); }
        $urls = array_values(array_filter(array_unique($urls)));
        if ($id && function_exists('rocket_clean_post')) rocket_clean_post($id);
        if ($urls && function_exists('rocket_clean_files')) rocket_clean_files($urls);
        if ($id) do_action('litespeed_purge_post', $id);
        foreach ($urls as $u) do_action('litespeed_purge_url', $u);
        if ($id && function_exists('w3tc_flush_post')) w3tc_flush_post($id);
        if ($id && function_exists('wp_cache_post_change')) wp_cache_post_change($id);
        if (function_exists('sg_cachepress_purge_cache')) foreach ($urls as $u) sg_cachepress_purge_cache($u);
        if ($id && class_exists('WpeCommon') && method_exists('WpeCommon', 'purge_varnish_cache')) WpeCommon::purge_varnish_cache($id);
        do_action('seo_agent_purged', $id, $urls);       // hook for site-specific CDNs
    }
}
SEO_Agent_Bridge::init();
```

**Notes on the mu-plugin**
- For Yoast, registering `_yoast_*` keys for every public type adds REST exposure for pages and CPTs. Yoast's own `post`-subtype registration continues to apply to posts.
- Rank Math redirects: if the agent should use Rank Math's table instead of the option map, replace the `/redirect` body with:
  ```php
  $rm = \RankMath\Redirections\Redirection::from(['url_to'=>$to,'header_code'=>$code]); $rm->add_source(ltrim($from,'/'),'exact'); $rm->save();   // add_source() is not chainable
  ```
  For the Redirection plugin, call `Red_Item::create([...])` with the same fields as its REST body.
- Add an IP allowlist or an HMAC header check in the `permission_callback`s if the site owner wants defence in depth beyond the Application Password.
- Keep the plugin **stateless apart from options and meta**. If you delete the file, all JSON-LD, redirects and robots overrides stop at once. That is the kill switch.

---

## 8. Endpoint cheat-sheet

| Purpose | Method + path |
|---|---|
| Discover REST root | `HEAD /` → `Link: rel="https://api.w.org/"`; `GET /wp-json/` |
| Verify auth | `GET /wp/v2/users/me?context=edit` |
| URL → ID | `HEAD <url>` → `Link: rel="alternate" type="application/json"`; `GET /wp/v2/{posts,pages}?slug=` |
| Read post (raw) | `GET /wp/v2/posts/<id>?context=edit` |
| Update post | `POST /wp/v2/posts/<id>` (`title`, `slug`, `content`, `excerpt`, `featured_media`, `meta`) |
| Alt text | `POST /wp/v2/media/<id>` (`alt_text`) |
| Revisions | `GET /wp/v2/posts/<id>/revisions[/<rid>]` (restore = re-POST values) |
| Settings | `GET/POST /wp/v2/settings` (`title`, `description`, `blog_public` is not exposed, use the companion `/info`) |
| Yoast meta (posts only) | `POST /wp/v2/posts/<id>` `meta._yoast_wpseo_title/metadesc/focuskw` |
| Yoast bulk | `POST /yoast/v1/bulk_editor/update_search` (≤ 20 items) |
| Yoast ability | `POST /wp-abilities/v1/abilities/yoast-seo/update-post-seo-data/run` |
| Yoast head (verify) | `GET /yoast/v1/get_head?url=` |
| Rank Math meta | `POST /rankmath/v1/updateMeta` |
| Rank Math schema | `POST /rankmath/v1/updateSchemas` |
| Rank Math post redirect | `POST /rankmath/v1/updateRedirection` |
| SEOPress title/desc | `PUT /seopress/v1/posts/<id>/title-description-metas` |
| SEOPress robots/canonical | `PUT /seopress/v1/posts/<id>/meta-robot-settings` |
| AIOSEO | `POST /wp-abilities/v1/abilities/aioseo-posts/seo-data-update/run` |
| Redirection plugin | `POST /redirection/v1/redirect`; `GET /redirection/v1/group` |
| Companion | `/seo-agent/v1/{info,resolve,meta/<id>,redirect,robots,llms,purge}` |
| Cloudflare purge | `POST api.cloudflare.com/client/v4/zones/<zone>/purge_cache` |

## Sources
- REST API authentication / Application Passwords: https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/
- Application Passwords integration guide: https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/
- REST API FAQ (Authorization header stripping, nginx args): https://developer.wordpress.org/rest-api/frequently-asked-questions/
- REST discovery: https://developer.wordpress.org/rest-api/using-the-rest-api/discovery/
- Posts / Pages / Media / Revisions reference: https://developer.wordpress.org/rest-api/reference/posts/ , https://developer.wordpress.org/rest-api/reference/media/ , https://developer.wordpress.org/rest-api/reference/post-revisions/
- register_meta / register_post_meta: https://developer.wordpress.org/reference/functions/register_meta/
- Core source (wordpress-develop trunk): https://github.com/WordPress/wordpress-develop/tree/trunk/src/wp-includes/rest-api (revisions controller, application-passwords controller, abilities run controller), src/wp-includes/user.php, meta.php
- Plugin sources (wordpress.org stable zips): https://downloads.wordpress.org/plugin/wordpress-seo.latest-stable.zip , seo-by-rank-math, wp-seopress, all-in-one-seo-pack, redirection, litespeed-cache
- Yoast REST API docs: https://developer.yoast.com/customization/apis/rest-api/
- Redirection REST API: https://redirection.me/developer/rest-api/
- Cloudflare purge API and limits: https://developers.cloudflare.com/api/resources/cache/methods/purge/ , https://developers.cloudflare.com/cache/how-to/purge-cache/
- WP Rocket programmatic purge: https://docs.wp-rocket.me/article/93-programmatically-clear-cache
- Community bridges (prior art): https://github.com/Devora-AS/rank-math-api-manager , https://wordpress.org/plugins/seo-fields-api-support/
