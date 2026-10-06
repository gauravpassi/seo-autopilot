<?php
/**
 * Plugin Name: SEO Agent Bridge
 * Description: Normalized, authenticated REST surface (namespace seo-agent/v1) that lets SEO Autopilot read and write SEO meta, JSON-LD, redirects, robots.txt / llms.txt and purge caches, with exact previous values for rollback.
 * Version:     1.0.0
 * Requires at least: 5.7
 * Requires PHP: 7.4
 * Author:      SEO Autopilot
 * License:     GPL-2.0-or-later
 *
 * ---------------------------------------------------------------------------------------------
 * INSTALL
 *   1. Upload this single file to  wp-content/mu-plugins/seo-agent-bridge.php
 *      (create the mu-plugins folder if it does not exist). Must-use plugins load automatically
 *      and cannot be deactivated from wp-admin. There is nothing to configure.
 *   2. Create a dedicated Administrator user (e.g. "seo-agent"), then under Users -> Profile ->
 *      Application Passwords create a password and paste it into the SEO Autopilot panel.
 *   3. Run "Test connection" in the panel. It should report "bridge version 1.0.0".
 *
 * UNINSTALL / KILL SWITCH
 *   Delete the file. All JSON-LD, redirects and robots.txt / llms.txt overrides served by the
 *   bridge stop immediately. SEO meta written into Yoast / Rank Math / SEOPress / AIOSEO stays,
 *   because it lives in those plugins' own storage. Bridge data lives in options named
 *   seo_agent_* and post meta named _seo_agent_*; remove them with WP-CLI if you want a clean DB:
 *     wp option delete seo_agent_redirects seo_agent_robots_txt seo_agent_llms_txt seo_agent_front
 *     wp post meta delete-all ... (or: wp db query "DELETE FROM wp_postmeta WHERE meta_key LIKE '\_seo\_agent\_%'")
 *
 * SECURITY
 *   - Every route requires an authenticated user. Site-wide routes (status, resolve, redirects,
 *     robots, llms, purge, homepage meta) require manage_options; per-post meta requires
 *     edit_post on that post. Authentication is WordPress core's (Application Passwords over
 *     HTTPS, or a logged-in cookie plus REST nonce); the bridge adds no auth scheme of its own.
 *   - Optional hardening via wp-config.php constants:
 *       define('SEO_AGENT_BRIDGE_USERS', 'seo-agent');            // comma list of user logins allowed to use the bridge
 *       define('SEO_AGENT_BRIDGE_ALLOWED_IPS', '203.0.113.7');     // comma list of client IPs (REMOTE_ADDR)
 *       define('SEO_AGENT_BRIDGE_REQUIRE_APP_PASSWORD', true);     // refuse cookie-authenticated calls
 *       define('SEO_AGENT_BRIDGE_DISABLE', true);                  // turn every route and output off
 *   - Input is validated and sanitized; JSON-LD is printed with JSON_HEX_TAG so a "</script>" in
 *     a value cannot break out of the script element. Redirect targets are restricted to http(s).
 *   - The bridge never runs arbitrary code, never edits files and never changes plugin settings
 *     other than the SEO fields listed below.
 *
 * ROUTES (all under /wp-json/seo-agent/v1, or ?rest_route=/seo-agent/v1/... without pretty permalinks)
 *   GET    /status                         environment: versions, active SEO plugin, caches, blog_public, physical files
 *   GET    /resolve?url=<url>              { id, type, rest_base, link, front }  (front=true: latest-posts homepage, id 0)
 *   GET    /meta/<id>                      { post_id, plugin, fields }            (id 0 = latest-posts homepage)
 *   POST   /meta/<id>   {fields...}        { before, after }  only keys present are changed; null or "" resets to default
 *            fields: title, description, canonical, robots {index,follow} (each true|false|null),
 *                    og_title, og_description, og_image, jsonld (array of JSON-LD objects | null)
 *   GET    /redirects                      { items: [{ from, to, code, created }] }
 *   POST   /redirects   {from,to,code}     { before, rule }   code 301 (default), 302, 307, 308 or 410
 *   DELETE /redirects?from=/path           { deleted, before }
 *   GET    /robots | /llms                 { content, physical, served_by_bridge, warning? }
 *   POST   /robots | /llms  {content}      { before, after, physical, warning? }  "" removes the override
 *   POST   /purge       {post_id?, urls?}  { ok, purged: [...] }
 * ---------------------------------------------------------------------------------------------
 */

defined('ABSPATH') || exit;

if (defined('SEO_AGENT_BRIDGE_DISABLE') && SEO_AGENT_BRIDGE_DISABLE) {
    return;
}
// Loaded twice (mu-plugin and regular plugin copy)? Declare and boot only once.
// The class is declared inside this block on purpose: an unconditional top-level class is
// hoisted by PHP, which would make a class_exists() guard always true.
if (!class_exists('SEO_Agent_Bridge', false)) :

final class SEO_Agent_Bridge
{
    const VERSION = '1.0.0';
    const NS = 'seo-agent/v1';

    const META_PREFIX = '_seo_agent_';
    const META_JSONLD = '_seo_agent_jsonld';
    const OPT_REDIRECTS = 'seo_agent_redirects';
    const OPT_ROBOTS = 'seo_agent_robots_txt';
    const OPT_LLMS = 'seo_agent_llms_txt';
    const OPT_FRONT = 'seo_agent_front';

    const MAX_ROBOTS = 20000;
    const MAX_LLMS = 100000;
    const MAX_JSONLD_BYTES = 65536;
    const MAX_REDIRECTS = 5000;

    /** Normalized fields and the plugin meta keys behind them. */
    const FIELDS = array('title', 'description', 'canonical', 'robots', 'og_title', 'og_description', 'og_image', 'jsonld');

    public static function init()
    {
        add_action('rest_api_init', array(__CLASS__, 'routes'));
        add_action('init', array(__CLASS__, 'serve_llms_txt'), 1);
        add_filter('robots_txt', array(__CLASS__, 'filter_robots_txt'), 99, 2);
        add_action('template_redirect', array(__CLASS__, 'serve_redirects'), 0);
        add_action('wp_head', array(__CLASS__, 'print_head'), 99);
        // Fallback output when no SEO plugin is active.
        add_filter('pre_get_document_title', array(__CLASS__, 'filter_document_title'), 99);
        add_filter('get_canonical_url', array(__CLASS__, 'filter_canonical'), 99, 2);
        add_filter('wp_robots', array(__CLASS__, 'filter_wp_robots'), 99);
    }

    /* =========================================================================================
     * Environment detection
     * ======================================================================================= */

    /** All active SEO plugins, in priority order. */
    public static function seo_plugins()
    {
        $out = array();
        if (defined('WPSEO_VERSION')) $out[] = 'yoast';
        if (class_exists('RankMath') || defined('RANK_MATH_VERSION')) $out[] = 'rankmath';
        if (defined('SEOPRESS_VERSION')) $out[] = 'seopress';
        if (function_exists('aioseo') || defined('AIOSEO_VERSION')) $out[] = 'aioseo';
        return $out;
    }

    /** The plugin the bridge writes into. "none" means the bridge stores and prints the fields itself. */
    public static function plugin()
    {
        $p = self::seo_plugins();
        return $p ? $p[0] : 'none';
    }

    public static function caching_plugins()
    {
        $c = array();
        if (defined('WP_ROCKET_VERSION')) $c[] = 'WP Rocket';
        if (defined('LSCWP_V')) $c[] = 'LiteSpeed Cache';
        if (defined('W3TC')) $c[] = 'W3 Total Cache';
        if (function_exists('wp_cache_post_change') || defined('WPCACHEHOME')) $c[] = 'WP Super Cache';
        if (function_exists('sg_cachepress_purge_cache') || class_exists('SiteGround_Optimizer\\Supercacher\\Supercacher')) $c[] = 'SiteGround Optimizer';
        if (class_exists('WpeCommon')) $c[] = 'WP Engine';
        if (class_exists('WpFastestCache')) $c[] = 'WP Fastest Cache';
        if (defined('CLOUDFLARE_PLUGIN_DIR')) $c[] = 'Cloudflare';
        if (defined('KINSTAMU_VERSION')) $c[] = 'Kinsta';
        if (class_exists('Breeze_PurgeCache')) $c[] = 'Breeze';
        if (defined('NGINX_HELPER_BASENAME')) $c[] = 'Nginx Helper';
        return $c;
    }

    private static function web_root()
    {
        if (!function_exists('get_home_path')) {
            require_once ABSPATH . 'wp-admin/includes/file.php';
        }
        $root = get_home_path();
        return $root ? trailingslashit($root) : ABSPATH;
    }

    private static function physical_file($name)
    {
        return file_exists(self::web_root() . $name) || file_exists(ABSPATH . $name);
    }

    private static function redirection_plugin_active()
    {
        return defined('REDIRECTION_VERSION') || class_exists('Red_Item');
    }

    /* =========================================================================================
     * Permissions
     * ======================================================================================= */

    private static function hardening_ok()
    {
        if (defined('SEO_AGENT_BRIDGE_ALLOWED_IPS') && SEO_AGENT_BRIDGE_ALLOWED_IPS) {
            $ips = array_filter(array_map('trim', explode(',', (string) SEO_AGENT_BRIDGE_ALLOWED_IPS)));
            $ip = isset($_SERVER['REMOTE_ADDR']) ? (string) $_SERVER['REMOTE_ADDR'] : '';
            if (!in_array($ip, $ips, true)) {
                return new WP_Error('seo_agent_ip', 'This IP is not allowed to use SEO Agent Bridge.', array('status' => 403));
            }
        }
        if (defined('SEO_AGENT_BRIDGE_USERS') && SEO_AGENT_BRIDGE_USERS) {
            $users = array_filter(array_map('trim', explode(',', (string) SEO_AGENT_BRIDGE_USERS)));
            $u = wp_get_current_user();
            if (!$u || !$u->exists() || !in_array($u->user_login, $users, true)) {
                return new WP_Error('seo_agent_user', 'This user is not allowed to use SEO Agent Bridge.', array('status' => 403));
            }
        }
        if (defined('SEO_AGENT_BRIDGE_REQUIRE_APP_PASSWORD') && SEO_AGENT_BRIDGE_REQUIRE_APP_PASSWORD) {
            if (!did_action('application_password_did_authenticate')) {
                return new WP_Error('seo_agent_app_password', 'SEO Agent Bridge requires Application Password authentication.', array('status' => 403));
            }
        }
        return true;
    }

    public static function can_manage()
    {
        if (!is_user_logged_in()) {
            return new WP_Error('rest_not_logged_in', 'Authentication required.', array('status' => 401));
        }
        $h = self::hardening_ok();
        if (is_wp_error($h)) return $h;
        return current_user_can('manage_options');
    }

    public static function can_edit_meta(WP_REST_Request $r)
    {
        if (!is_user_logged_in()) {
            return new WP_Error('rest_not_logged_in', 'Authentication required.', array('status' => 401));
        }
        $h = self::hardening_ok();
        if (is_wp_error($h)) return $h;
        $id = (int) $r['id'];
        if ($id === 0) return current_user_can('manage_options'); // homepage settings are site-wide
        if (!get_post($id)) return new WP_Error('rest_post_invalid_id', 'Invalid post ID.', array('status' => 404));
        return current_user_can('edit_post', $id);
    }

    /* =========================================================================================
     * REST routes
     * ======================================================================================= */

    public static function routes()
    {
        $manage = array(__CLASS__, 'can_manage');

        register_rest_route(self::NS, '/status', array(
            'methods' => 'GET',
            'permission_callback' => $manage,
            'callback' => array(__CLASS__, 'route_status'),
        ));

        register_rest_route(self::NS, '/resolve', array(
            'methods' => 'GET',
            'permission_callback' => $manage,
            'callback' => array(__CLASS__, 'route_resolve'),
            'args' => array('url' => array('required' => true, 'type' => 'string')),
        ));

        register_rest_route(self::NS, '/meta/(?P<id>\d+)', array(
            array(
                'methods' => 'GET',
                'permission_callback' => array(__CLASS__, 'can_edit_meta'),
                'callback' => array(__CLASS__, 'route_meta_get'),
            ),
            array(
                'methods' => 'POST, PUT, PATCH',
                'permission_callback' => array(__CLASS__, 'can_edit_meta'),
                'callback' => array(__CLASS__, 'route_meta_post'),
            ),
        ));

        register_rest_route(self::NS, '/redirects', array(
            array('methods' => 'GET', 'permission_callback' => $manage, 'callback' => array(__CLASS__, 'route_redirects_list')),
            array('methods' => 'POST', 'permission_callback' => $manage, 'callback' => array(__CLASS__, 'route_redirects_create')),
            array('methods' => 'DELETE', 'permission_callback' => $manage, 'callback' => array(__CLASS__, 'route_redirects_delete')),
        ));

        foreach (array('robots', 'llms') as $file) {
            register_rest_route(self::NS, '/' . $file, array(
                array(
                    'methods' => 'GET',
                    'permission_callback' => $manage,
                    'callback' => function () use ($file) {
                        return SEO_Agent_Bridge::route_file_get($file);
                    },
                ),
                array(
                    'methods' => 'POST',
                    'permission_callback' => $manage,
                    'callback' => function (WP_REST_Request $r) use ($file) {
                        return SEO_Agent_Bridge::route_file_post($file, $r);
                    },
                ),
            ));
        }

        register_rest_route(self::NS, '/purge', array(
            'methods' => 'POST',
            'permission_callback' => $manage,
            'callback' => array(__CLASS__, 'route_purge'),
        ));
    }

    public static function route_status()
    {
        global $wp_version;
        return array(
            'version' => self::VERSION,
            'wp_version' => $wp_version,
            'php_version' => PHP_VERSION,
            'seo_plugin' => self::plugin(),
            'seo_plugins' => self::seo_plugins(),
            'blog_public' => (int) get_option('blog_public') === 1,
            'physical_robots' => self::physical_file('robots.txt'),
            'physical_llms' => self::physical_file('llms.txt'),
            'redirection_plugin' => self::redirection_plugin_active(),
            'caching' => self::caching_plugins(),
            'permalink_structure' => (string) get_option('permalink_structure'),
            'show_on_front' => (string) get_option('show_on_front'),
            'home' => home_url('/'),
            'multisite' => is_multisite(),
            'fields' => self::FIELDS,
        );
    }

    public static function route_resolve(WP_REST_Request $r)
    {
        $url = esc_url_raw((string) $r['url'], array('http', 'https'));
        if (!$url) return new WP_Error('seo_agent_bad_url', 'url must be an http(s) URL.', array('status' => 400));

        $home_path = untrailingslashit((string) wp_parse_url(home_url('/'), PHP_URL_PATH));
        $path = untrailingslashit((string) wp_parse_url($url, PHP_URL_PATH));
        $is_home = ($path === $home_path);
        if ($is_home) {
            if (get_option('show_on_front') === 'page' && (int) get_option('page_on_front') > 0) {
                $id = (int) get_option('page_on_front');
                return self::resolve_result($id);
            }
            return array('id' => 0, 'type' => null, 'rest_base' => null, 'link' => home_url('/'), 'front' => true);
        }
        $id = (int) url_to_postid($url);
        if ($id <= 0) {
            return array('id' => 0, 'type' => null, 'rest_base' => null, 'link' => null, 'front' => false);
        }
        return self::resolve_result($id);
    }

    private static function resolve_result($id)
    {
        $type = get_post_type($id);
        $obj = $type ? get_post_type_object($type) : null;
        $rest_base = null;
        if ($obj) {
            $rest_base = !empty($obj->rest_base) ? $obj->rest_base : $obj->name;
        }
        return array(
            'id' => (int) $id,
            'type' => $type ?: null,
            'rest_base' => $rest_base,
            'link' => get_permalink($id) ?: null,
            'front' => false,
        );
    }

    public static function route_meta_get(WP_REST_Request $r)
    {
        $id = (int) $r['id'];
        $fields = self::read_fields($id);
        if (is_wp_error($fields)) return $fields;
        return array('post_id' => $id, 'plugin' => self::plugin(), 'fields' => $fields);
    }

    public static function route_meta_post(WP_REST_Request $r)
    {
        $id = (int) $r['id'];
        $in = $r->get_json_params();
        if (!is_array($in)) $in = $r->get_body_params();
        if (!is_array($in)) return new WP_Error('seo_agent_bad_body', 'JSON object body required.', array('status' => 400));
        if (isset($in['fields']) && is_array($in['fields'])) $in = $in['fields'];

        $clean = self::validate_fields($in, $id);
        if (is_wp_error($clean)) return $clean;
        if (!$clean) return new WP_Error('seo_agent_no_fields', 'No known fields in body. Known: ' . implode(', ', self::FIELDS), array('status' => 400));

        $before = self::read_fields($id);
        if (is_wp_error($before)) return $before;
        $res = self::write_fields($id, $clean);
        if (is_wp_error($res)) return $res;
        self::purge($id, $id === 0 ? array(home_url('/')) : array());
        $after = self::read_fields($id);
        return array('post_id' => $id, 'plugin' => self::plugin(), 'before' => $before, 'after' => $after);
    }

    public static function route_redirects_list()
    {
        $items = array();
        foreach (self::redirect_map() as $rule) {
            $items[] = $rule;
        }
        return array('items' => $items, 'redirection_plugin' => self::redirection_plugin_active());
    }

    public static function route_redirects_create(WP_REST_Request $r)
    {
        $from = self::clean_path((string) $r['from']);
        if (is_wp_error($from)) return $from;
        $code = $r['code'] === null ? 301 : (int) $r['code'];
        if (!in_array($code, array(301, 302, 307, 308, 410), true)) {
            return new WP_Error('seo_agent_bad_code', 'code must be 301, 302, 307, 308 or 410.', array('status' => 400));
        }
        $to = '';
        if ($code !== 410) {
            $raw = trim((string) $r['to']);
            if ($raw !== '' && $raw[0] === '/' && (strlen($raw) < 2 || $raw[1] !== '/')) $raw = home_url($raw);
            $to = esc_url_raw($raw, array('http', 'https'));
            if (!$to) return new WP_Error('seo_agent_bad_to', 'to must be an http(s) URL or a path.', array('status' => 400));
            $to_host = strtolower((string) wp_parse_url($to, PHP_URL_HOST));
            $home_host = strtolower((string) wp_parse_url(home_url('/'), PHP_URL_HOST));
            $to_path = (string) wp_parse_url($to, PHP_URL_PATH);
            if (self::host_key($to_host) === self::host_key($home_host) && self::path_key($to_path === '' ? '/' : $to_path) === self::path_key($from)) {
                return new WP_Error('seo_agent_loop', 'Redirect target is the same as the source.', array('status' => 400));
            }
            // Refuse chains through our own map: A -> B where B already redirects.
            $map = self::redirect_map();
            if (self::host_key($to_host) === self::host_key($home_host) && isset($map[self::path_key($to_path)])) {
                return new WP_Error('seo_agent_chain', 'Redirect target ' . $to_path . ' itself redirects; point to the final URL instead.', array('status' => 409));
            }
        }

        $map = self::redirect_map();
        $key = self::path_key($from);
        if (!isset($map[$key]) && count($map) >= self::MAX_REDIRECTS) {
            return new WP_Error('seo_agent_too_many', 'Redirect limit reached (' . self::MAX_REDIRECTS . ').', array('status' => 409));
        }
        $before = isset($map[$key]) ? $map[$key] : null;
        $rule = array('from' => $from, 'to' => $to, 'code' => $code, 'created' => gmdate('c'));
        $map[$key] = $rule;
        update_option(self::OPT_REDIRECTS, $map, true);
        self::purge(0, array(home_url($from)));
        return array('before' => $before, 'rule' => $rule);
    }

    public static function route_redirects_delete(WP_REST_Request $r)
    {
        $from = self::clean_path((string) $r['from']);
        if (is_wp_error($from)) return $from;
        $map = self::redirect_map();
        $key = self::path_key($from);
        $before = isset($map[$key]) ? $map[$key] : null;
        if ($before) {
            unset($map[$key]);
            update_option(self::OPT_REDIRECTS, $map, true);
            self::purge(0, array(home_url($from)));
        }
        return array('deleted' => (bool) $before, 'before' => $before);
    }

    public static function route_file_get($file)
    {
        $content = (string) get_option($file === 'robots' ? self::OPT_ROBOTS : self::OPT_LLMS, '');
        $physical = self::physical_file($file . '.txt');
        $out = array(
            'content' => $content,
            'physical' => $physical,
            'served_by_bridge' => $content !== '' && !$physical && ($file !== 'robots' || (int) get_option('blog_public') === 1),
        );
        $w = self::file_warning($file, $physical);
        if ($w) $out['warning'] = $w;
        return $out;
    }

    public static function route_file_post($file, WP_REST_Request $r)
    {
        $opt = $file === 'robots' ? self::OPT_ROBOTS : self::OPT_LLMS;
        $max = $file === 'robots' ? self::MAX_ROBOTS : self::MAX_LLMS;
        $content = self::clean_text_file($r['content']);
        if (strlen($content) > $max) {
            return new WP_Error('seo_agent_too_large', $file . '.txt is limited to ' . $max . ' bytes.', array('status' => 413));
        }
        $physical = self::physical_file($file . '.txt');
        $before = (string) get_option($opt, '');
        if ($content === '') {
            delete_option($opt);
        } else {
            update_option($opt, $content, false);
        }
        self::purge(0, array(home_url('/' . $file . '.txt')));
        $out = array('before' => $before, 'after' => (string) get_option($opt, ''), 'physical' => $physical);
        $w = self::file_warning($file, $physical);
        if ($w) $out['warning'] = $w;
        return $out;
    }

    private static function file_warning($file, $physical)
    {
        if ($physical) {
            return 'A physical ' . $file . '.txt exists in the web root. The web server serves it directly, so the bridge override is not visible until that file is removed.';
        }
        if ($file === 'robots' && (int) get_option('blog_public') !== 1) {
            return '"Discourage search engines" is on (Settings -> Reading). WordPress serves "Disallow: /" and the bridge does not override it.';
        }
        if ($file === 'robots' && !get_option('permalink_structure')) {
            return 'Plain permalinks: WordPress only serves a virtual robots.txt when the web server routes /robots.txt to index.php.';
        }
        return null;
    }

    public static function route_purge(WP_REST_Request $r)
    {
        $id = (int) $r['post_id'];
        $urls = $r['urls'];
        $urls = is_array($urls) ? $urls : array();
        $clean = array();
        foreach ($urls as $u) {
            $u = esc_url_raw((string) $u, array('http', 'https'));
            if ($u) $clean[] = $u;
        }
        $purged = self::purge($id, $clean);
        return array('ok' => true, 'purged' => $purged);
    }

    /* =========================================================================================
     * Field validation
     * ======================================================================================= */

    private static function validate_fields(array $in, $id)
    {
        $out = array();
        foreach ($in as $k => $v) {
            if (!in_array($k, self::FIELDS, true)) continue;
            if ($v === '' ) $v = null;
            switch ($k) {
                case 'title':
                case 'description':
                case 'og_title':
                case 'og_description':
                    if ($v !== null && !is_scalar($v)) return new WP_Error('seo_agent_bad_field', $k . ' must be a string.', array('status' => 400));
                    $out[$k] = $v === null ? null : sanitize_text_field((string) $v);
                    if ($out[$k] === '') $out[$k] = null;
                    break;
                case 'canonical':
                case 'og_image':
                    if ($v === null) {
                        $out[$k] = null;
                        break;
                    }
                    $u = esc_url_raw((string) $v, array('http', 'https'));
                    if (!$u) return new WP_Error('seo_agent_bad_field', $k . ' must be an http(s) URL.', array('status' => 400));
                    $out[$k] = $u;
                    break;
                case 'robots':
                    if ($v === null) {
                        $out[$k] = array('index' => null, 'follow' => null);
                        break;
                    }
                    if (!is_array($v)) return new WP_Error('seo_agent_bad_field', 'robots must be {index, follow}.', array('status' => 400));
                    $out[$k] = array(
                        'index' => array_key_exists('index', $v) && $v['index'] !== null ? (bool) $v['index'] : null,
                        'follow' => array_key_exists('follow', $v) && $v['follow'] !== null ? (bool) $v['follow'] : null,
                    );
                    break;
                case 'jsonld':
                    if ($v === null) {
                        $out[$k] = null;
                        break;
                    }
                    if (is_string($v)) $v = json_decode($v, true);
                    if (!is_array($v)) return new WP_Error('seo_agent_bad_jsonld', 'jsonld must be an array of JSON-LD objects.', array('status' => 400));
                    // A single object is accepted and wrapped.
                    if (isset($v['@type']) || isset($v['@graph']) || isset($v['@context'])) $v = array($v);
                    $blocks = array();
                    foreach ($v as $block) {
                        if (!is_array($block) || (!isset($block['@type']) && !isset($block['@graph']))) {
                            return new WP_Error('seo_agent_bad_jsonld', 'Each JSON-LD block must be an object with @type or @graph.', array('status' => 400));
                        }
                        $blocks[] = $block;
                    }
                    $json = wp_json_encode($blocks, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
                    if ($json === false || strlen($json) > self::MAX_JSONLD_BYTES) {
                        return new WP_Error('seo_agent_bad_jsonld', 'jsonld is not encodable or larger than ' . self::MAX_JSONLD_BYTES . ' bytes.', array('status' => 400));
                    }
                    $out[$k] = $blocks ? $blocks : null;
                    break;
            }
        }
        if ($id === 0) {
            $p = self::plugin();
            $allowed = $p === 'none' ? self::FIELDS : array('title', 'description', 'jsonld');
            foreach (array_keys($out) as $k) {
                if (!in_array($k, $allowed, true)) {
                    return new WP_Error('seo_agent_unsupported', 'Field "' . $k . '" is not supported on a latest-posts homepage with ' . $p . '; set it in the SEO plugin.', array('status' => 400));
                }
            }
        }
        return $out;
    }

    /* =========================================================================================
     * Normalized read / write
     * ======================================================================================= */

    private static function empty_fields()
    {
        return array(
            'title' => null, 'description' => null, 'canonical' => null,
            'robots' => array('index' => null, 'follow' => null),
            'og_title' => null, 'og_description' => null, 'og_image' => null, 'jsonld' => null,
        );
    }

    private static function s($v)
    {
        if ($v === null || $v === false) return null;
        if (is_array($v)) return null;
        $v = (string) $v;
        return $v === '' ? null : $v;
    }

    public static function read_fields($id)
    {
        $f = self::empty_fields();
        if ($id === 0) {
            return self::read_front($f);
        }
        $p = self::plugin();
        switch ($p) {
            case 'yoast':
                $f['title'] = self::s(get_post_meta($id, '_yoast_wpseo_title', true));
                $f['description'] = self::s(get_post_meta($id, '_yoast_wpseo_metadesc', true));
                $f['canonical'] = self::s(get_post_meta($id, '_yoast_wpseo_canonical', true));
                $ni = (string) get_post_meta($id, '_yoast_wpseo_meta-robots-noindex', true);
                $nf = (string) get_post_meta($id, '_yoast_wpseo_meta-robots-nofollow', true);
                $f['robots'] = array(
                    'index' => $ni === '1' ? false : ($ni === '2' ? true : null),
                    'follow' => $nf === '1' ? false : null,
                );
                $f['og_title'] = self::s(get_post_meta($id, '_yoast_wpseo_opengraph-title', true));
                $f['og_description'] = self::s(get_post_meta($id, '_yoast_wpseo_opengraph-description', true));
                $f['og_image'] = self::s(get_post_meta($id, '_yoast_wpseo_opengraph-image', true));
                break;
            case 'rankmath':
                $f['title'] = self::s(get_post_meta($id, 'rank_math_title', true));
                $f['description'] = self::s(get_post_meta($id, 'rank_math_description', true));
                $f['canonical'] = self::s(get_post_meta($id, 'rank_math_canonical_url', true));
                $rob = get_post_meta($id, 'rank_math_robots', true);
                $rob = is_array($rob) ? $rob : array();
                $f['robots'] = array(
                    'index' => in_array('noindex', $rob, true) ? false : (in_array('index', $rob, true) ? true : null),
                    'follow' => in_array('nofollow', $rob, true) ? false : (in_array('follow', $rob, true) ? true : null),
                );
                $f['og_title'] = self::s(get_post_meta($id, 'rank_math_facebook_title', true));
                $f['og_description'] = self::s(get_post_meta($id, 'rank_math_facebook_description', true));
                $f['og_image'] = self::s(get_post_meta($id, 'rank_math_facebook_image', true));
                break;
            case 'seopress':
                $f['title'] = self::s(get_post_meta($id, '_seopress_titles_title', true));
                $f['description'] = self::s(get_post_meta($id, '_seopress_titles_desc', true));
                $f['canonical'] = self::s(get_post_meta($id, '_seopress_robots_canonical', true));
                $f['robots'] = array(
                    'index' => get_post_meta($id, '_seopress_robots_index', true) === 'yes' ? false : null,
                    'follow' => get_post_meta($id, '_seopress_robots_follow', true) === 'yes' ? false : null,
                );
                $f['og_title'] = self::s(get_post_meta($id, '_seopress_social_fb_title', true));
                $f['og_description'] = self::s(get_post_meta($id, '_seopress_social_fb_desc', true));
                $f['og_image'] = self::s(get_post_meta($id, '_seopress_social_fb_img', true));
                break;
            case 'aioseo':
                $m = self::aioseo_model($id);
                if (is_wp_error($m)) return $m;
                $f['title'] = self::s($m->title);
                $f['description'] = self::s($m->description);
                $f['canonical'] = self::s($m->canonical_url);
                $default = !isset($m->robots_default) || (bool) $m->robots_default;
                $f['robots'] = array(
                    'index' => $default ? null : !((bool) $m->robots_noindex),
                    'follow' => $default ? null : !((bool) $m->robots_nofollow),
                );
                $f['og_title'] = self::s($m->og_title);
                $f['og_description'] = self::s($m->og_description);
                $f['og_image'] = isset($m->og_image_type) && $m->og_image_type === 'custom_image' ? self::s($m->og_image_custom_url) : null;
                break;
            default:
                foreach (array('title', 'description', 'canonical', 'og_title', 'og_description', 'og_image') as $k) {
                    $f[$k] = self::s(get_post_meta($id, self::META_PREFIX . $k, true));
                }
                $ni = (string) get_post_meta($id, self::META_PREFIX . 'noindex', true);
                $nf = (string) get_post_meta($id, self::META_PREFIX . 'nofollow', true);
                $f['robots'] = array('index' => $ni === '1' ? false : null, 'follow' => $nf === '1' ? false : null);
        }
        $f['jsonld'] = self::read_jsonld_meta($id);
        return $f;
    }

    private static function read_jsonld_meta($id)
    {
        $raw = get_post_meta($id, self::META_JSONLD, true);
        if (!$raw) return null;
        $data = is_array($raw) ? $raw : json_decode((string) $raw, true);
        return is_array($data) && $data ? array_values($data) : null;
    }

    private static function set_meta($id, $key, $value)
    {
        if ($value === null || $value === '' || $value === array()) {
            delete_post_meta($id, $key);
        } else {
            update_post_meta($id, $key, is_string($value) ? wp_slash($value) : $value);
        }
    }

    private static function attachment_id_for($url)
    {
        if (!$url) return 0;
        $id = attachment_url_to_postid($url);
        if (!$id) {
            // Strip a size suffix (-300x200) and retry.
            $id = attachment_url_to_postid(preg_replace('/-\d+x\d+(?=\.[a-z0-9]+$)/i', '', $url));
        }
        return (int) $id;
    }

    public static function write_fields($id, array $in)
    {
        if ($id === 0) return self::write_front($in);

        if (array_key_exists('jsonld', $in)) {
            if ($in['jsonld'] === null) {
                delete_post_meta($id, self::META_JSONLD);
            } else {
                update_post_meta($id, self::META_JSONLD, wp_slash(wp_json_encode(array_values($in['jsonld']), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)));
            }
        }

        $p = self::plugin();
        switch ($p) {
            case 'yoast':
                $keys = array(
                    'title' => '_yoast_wpseo_title',
                    'description' => '_yoast_wpseo_metadesc',
                    'canonical' => '_yoast_wpseo_canonical',
                    'og_title' => '_yoast_wpseo_opengraph-title',
                    'og_description' => '_yoast_wpseo_opengraph-description',
                    'og_image' => '_yoast_wpseo_opengraph-image',
                );
                foreach ($keys as $f => $k) {
                    if (array_key_exists($f, $in)) self::set_meta($id, $k, $in[$f]);
                }
                if (array_key_exists('og_image', $in)) {
                    $aid = self::attachment_id_for($in['og_image']);
                    self::set_meta($id, '_yoast_wpseo_opengraph-image-id', $aid ? (string) $aid : null);
                }
                if (array_key_exists('robots', $in)) {
                    $r = $in['robots'];
                    self::set_meta($id, '_yoast_wpseo_meta-robots-noindex', $r['index'] === false ? '1' : ($r['index'] === true ? '2' : null));
                    self::set_meta($id, '_yoast_wpseo_meta-robots-nofollow', $r['follow'] === false ? '1' : null);
                }
                break;

            case 'rankmath':
                $keys = array(
                    'title' => 'rank_math_title',
                    'description' => 'rank_math_description',
                    'canonical' => 'rank_math_canonical_url',
                    'og_title' => 'rank_math_facebook_title',
                    'og_description' => 'rank_math_facebook_description',
                    'og_image' => 'rank_math_facebook_image',
                );
                foreach ($keys as $f => $k) {
                    if (array_key_exists($f, $in)) self::set_meta($id, $k, $in[$f]);
                }
                if (array_key_exists('og_image', $in)) {
                    $aid = self::attachment_id_for($in['og_image']);
                    self::set_meta($id, 'rank_math_facebook_image_id', $aid ? (string) $aid : null);
                }
                if (array_key_exists('robots', $in)) {
                    $r = $in['robots'];
                    $rob = get_post_meta($id, 'rank_math_robots', true);
                    $rob = is_array($rob) ? $rob : array();
                    $rob = array_values(array_diff($rob, array('index', 'noindex', 'follow', 'nofollow')));
                    if ($r['index'] !== null) $rob[] = $r['index'] ? 'index' : 'noindex';
                    if ($r['follow'] !== null) $rob[] = $r['follow'] ? 'follow' : 'nofollow';
                    self::set_meta($id, 'rank_math_robots', $rob ? $rob : null);
                }
                break;

            case 'seopress':
                $keys = array(
                    'title' => '_seopress_titles_title',
                    'description' => '_seopress_titles_desc',
                    'canonical' => '_seopress_robots_canonical',
                    'og_title' => '_seopress_social_fb_title',
                    'og_description' => '_seopress_social_fb_desc',
                    'og_image' => '_seopress_social_fb_img',
                );
                foreach ($keys as $f => $k) {
                    if (array_key_exists($f, $in)) self::set_meta($id, $k, $in[$f]);
                }
                if (array_key_exists('og_image', $in)) {
                    $aid = self::attachment_id_for($in['og_image']);
                    self::set_meta($id, '_seopress_social_fb_img_attachment_id', $aid ? (string) $aid : null);
                }
                if (array_key_exists('robots', $in)) {
                    $r = $in['robots'];
                    self::set_meta($id, '_seopress_robots_index', $r['index'] === false ? 'yes' : null);
                    self::set_meta($id, '_seopress_robots_follow', $r['follow'] === false ? 'yes' : null);
                }
                break;

            case 'aioseo':
                $m = self::aioseo_model($id);
                if (is_wp_error($m)) return $m;
                $map = array('title' => 'title', 'description' => 'description', 'canonical' => 'canonical_url', 'og_title' => 'og_title', 'og_description' => 'og_description');
                foreach ($map as $f => $col) {
                    if (array_key_exists($f, $in)) $m->$col = $in[$f];
                }
                if (array_key_exists('og_image', $in)) {
                    $m->og_image_custom_url = $in['og_image'];
                    $m->og_image_type = $in['og_image'] ? 'custom_image' : 'default';
                }
                if (array_key_exists('robots', $in)) {
                    $r = $in['robots'];
                    if ($r['index'] === null && $r['follow'] === null) {
                        $m->robots_default = 1;
                        $m->robots_noindex = 0;
                        $m->robots_nofollow = 0;
                    } else {
                        $m->robots_default = 0;
                        $m->robots_noindex = $r['index'] === false ? 1 : 0;
                        $m->robots_nofollow = $r['follow'] === false ? 1 : 0;
                    }
                }
                if (!isset($m->post_id) || !$m->post_id) $m->post_id = $id;
                $m->save();
                break;

            default:
                foreach (array('title', 'description', 'canonical', 'og_title', 'og_description', 'og_image') as $k) {
                    if (array_key_exists($k, $in)) self::set_meta($id, self::META_PREFIX . $k, $in[$k]);
                }
                if (array_key_exists('robots', $in)) {
                    self::set_meta($id, self::META_PREFIX . 'noindex', $in['robots']['index'] === false ? '1' : null);
                    self::set_meta($id, self::META_PREFIX . 'nofollow', $in['robots']['follow'] === false ? '1' : null);
                }
        }

        // update_post_meta() fires updated_post_meta, which Yoast's indexable watcher and Rank Math
        // listen to. We deliberately do NOT fire save_post: third-party save_post handlers often
        // read $_POST and can wipe data when called outside the editor.
        clean_post_cache($id);
        do_action('seo_agent_meta_updated', $id, $in);
        return true;
    }

    /** AIOSEO stores per-post data in its own table; use its model. */
    private static function aioseo_model($id)
    {
        if (!class_exists('\\AIOSEO\\Plugin\\Common\\Models\\Post')) {
            return new WP_Error('seo_agent_aioseo', 'AIOSEO is active but its Post model was not found (unsupported AIOSEO version).', array('status' => 501));
        }
        $m = \AIOSEO\Plugin\Common\Models\Post::getPost($id);
        if (!$m) return new WP_Error('seo_agent_aioseo', 'AIOSEO post model unavailable.', array('status' => 500));
        return $m;
    }

    /* ---------- latest-posts homepage (id 0) ---------- */

    private static function read_front(array $f)
    {
        $p = self::plugin();
        if ($p === 'yoast') {
            $o = get_option('wpseo_titles', array());
            $f['title'] = self::s(isset($o['title-home-wpseo']) ? $o['title-home-wpseo'] : null);
            $f['description'] = self::s(isset($o['metadesc-home-wpseo']) ? $o['metadesc-home-wpseo'] : null);
        } elseif ($p === 'rankmath') {
            $o = get_option('rank-math-options-titles', array());
            $f['title'] = self::s(isset($o['homepage_title']) ? $o['homepage_title'] : null);
            $f['description'] = self::s(isset($o['homepage_description']) ? $o['homepage_description'] : null);
        } elseif ($p === 'seopress') {
            $o = get_option('seopress_titles_option_name', array());
            $f['title'] = self::s(isset($o['seopress_titles_home_site_title']) ? $o['seopress_titles_home_site_title'] : null);
            $f['description'] = self::s(isset($o['seopress_titles_home_site_desc']) ? $o['seopress_titles_home_site_desc'] : null);
        } elseif ($p === 'aioseo') {
            try {
                $g = aioseo()->options->searchAppearance->global;
                $f['title'] = self::s($g->siteTitle);
                $f['description'] = self::s($g->metaDescription);
            } catch (\Throwable $e) {
                return new WP_Error('seo_agent_aioseo', 'Could not read AIOSEO homepage settings: ' . $e->getMessage(), array('status' => 500));
            }
        }
        $own = get_option(self::OPT_FRONT, array());
        $own = is_array($own) ? $own : array();
        if ($p === 'none') {
            foreach (array('title', 'description', 'canonical', 'og_title', 'og_description', 'og_image') as $k) {
                $f[$k] = self::s(isset($own[$k]) ? $own[$k] : null);
            }
            if (isset($own['robots']) && is_array($own['robots'])) $f['robots'] = $own['robots'];
        }
        $f['jsonld'] = isset($own['jsonld']) && is_array($own['jsonld']) && $own['jsonld'] ? array_values($own['jsonld']) : null;
        return $f;
    }

    private static function write_front(array $in)
    {
        $p = self::plugin();
        $own = get_option(self::OPT_FRONT, array());
        $own = is_array($own) ? $own : array();
        foreach ($in as $k => $v) {
            if ($k === 'jsonld' || $p === 'none') {
                if ($v === null || ($k === 'robots' && $v['index'] === null && $v['follow'] === null)) unset($own[$k]);
                else $own[$k] = $v;
            }
        }
        update_option(self::OPT_FRONT, $own, true);

        $title = array_key_exists('title', $in) ? (string) $in['title'] : null;
        $desc = array_key_exists('description', $in) ? (string) $in['description'] : null;
        if ($p === 'yoast') {
            $o = get_option('wpseo_titles', array());
            if ($title !== null) $o['title-home-wpseo'] = $title;
            if ($desc !== null) $o['metadesc-home-wpseo'] = $desc;
            update_option('wpseo_titles', $o);
        } elseif ($p === 'rankmath') {
            $o = get_option('rank-math-options-titles', array());
            if ($title !== null) $o['homepage_title'] = $title;
            if ($desc !== null) $o['homepage_description'] = $desc;
            update_option('rank-math-options-titles', $o);
        } elseif ($p === 'seopress') {
            $o = get_option('seopress_titles_option_name', array());
            if ($title !== null) $o['seopress_titles_home_site_title'] = $title;
            if ($desc !== null) $o['seopress_titles_home_site_desc'] = $desc;
            update_option('seopress_titles_option_name', $o);
        } elseif ($p === 'aioseo' && ($title !== null || $desc !== null)) {
            try {
                $g = aioseo()->options->searchAppearance->global;
                if ($title !== null) $g->siteTitle = $title;
                if ($desc !== null) $g->metaDescription = $desc;
            } catch (\Throwable $e) {
                return new WP_Error('seo_agent_aioseo', 'Could not write AIOSEO homepage settings: ' . $e->getMessage(), array('status' => 500));
            }
        }
        do_action('seo_agent_meta_updated', 0, $in);
        return true;
    }

    /* =========================================================================================
     * Front-end output
     * ======================================================================================= */

    /** Post ID whose fields apply to this request, 0 for a latest-posts homepage, null otherwise. */
    private static function context_id()
    {
        if (is_front_page() && is_home()) return 0;
        if (is_singular()) return (int) get_queried_object_id();
        return null;
    }

    private static function own_fields($ctx)
    {
        static $cache = array();
        $key = (string) $ctx;
        if (!isset($cache[$key])) {
            $cache[$key] = $ctx === 0 ? self::read_front(self::empty_fields()) : self::read_fields($ctx);
            if (is_wp_error($cache[$key])) $cache[$key] = self::empty_fields();
        }
        return $cache[$key];
    }

    public static function print_head()
    {
        $ctx = self::context_id();
        if ($ctx === null) return;

        if ($ctx === 0) {
            $own = get_option(self::OPT_FRONT, array());
            $blocks = is_array($own) && isset($own['jsonld']) && is_array($own['jsonld']) ? $own['jsonld'] : array();
        } else {
            $blocks = self::read_jsonld_meta($ctx);
            $blocks = $blocks ? $blocks : array();
        }
        foreach ($blocks as $g) {
            if (!is_array($g)) continue;
            if (!isset($g['@context'])) $g = array('@context' => 'https://schema.org') + $g;
            $json = wp_json_encode($g, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP);
            if ($json) {
                echo "\n<script type=\"application/ld+json\" class=\"seo-agent-schema\">" . $json . "</script>\n";
            }
        }

        if (self::plugin() !== 'none') return;
        // Minimal head output when no SEO plugin is active.
        $f = self::own_fields($ctx);
        if ($f['description']) echo '<meta name="description" content="' . esc_attr($f['description']) . "\" />\n";
        if ($ctx === 0 && $f['canonical']) echo '<link rel="canonical" href="' . esc_url($f['canonical']) . "\" />\n";
        if (!function_exists('wp_robots')) {
            $r = $f['robots'];
            $parts = array();
            if ($r['index'] === false) $parts[] = 'noindex';
            if ($r['follow'] === false) $parts[] = 'nofollow';
            if ($parts) echo '<meta name="robots" content="' . esc_attr(implode(', ', $parts)) . "\" />\n";
        }
        if ($f['og_title']) echo '<meta property="og:title" content="' . esc_attr($f['og_title']) . "\" />\n";
        if ($f['og_description']) echo '<meta property="og:description" content="' . esc_attr($f['og_description']) . "\" />\n";
        if ($f['og_image']) echo '<meta property="og:image" content="' . esc_url($f['og_image']) . "\" />\n";
    }

    public static function filter_document_title($title)
    {
        if (self::plugin() !== 'none') return $title;
        $ctx = self::context_id();
        if ($ctx === null) return $title;
        $f = self::own_fields($ctx);
        return $f['title'] ? $f['title'] : $title;
    }

    public static function filter_canonical($url, $post = null)
    {
        if (self::plugin() !== 'none' || !$post) return $url;
        $f = self::own_fields((int) $post->ID);
        return $f['canonical'] ? $f['canonical'] : $url;
    }

    public static function filter_wp_robots($robots)
    {
        if (self::plugin() !== 'none') return $robots;
        $ctx = self::context_id();
        if ($ctx === null) return $robots;
        $r = self::own_fields($ctx)['robots'];
        if ($r['index'] === false) {
            $robots['noindex'] = true;
            unset($robots['max-image-preview']);
        }
        if ($r['follow'] === false) $robots['nofollow'] = true;
        return $robots;
    }

    /* ---------- robots.txt ---------- */

    public static function filter_robots_txt($output, $public)
    {
        if (!$public) return $output; // never open up a site that is set to "discourage search engines"
        $custom = (string) get_option(self::OPT_ROBOTS, '');
        return $custom !== '' ? $custom : $output;
    }

    /* ---------- llms.txt ---------- */

    public static function serve_llms_txt()
    {
        if (is_admin() || (defined('REST_REQUEST') && REST_REQUEST) || (defined('WP_CLI') && WP_CLI) || wp_doing_ajax() || wp_doing_cron()) return;
        $method = isset($_SERVER['REQUEST_METHOD']) ? strtoupper((string) $_SERVER['REQUEST_METHOD']) : 'GET';
        if ($method !== 'GET' && $method !== 'HEAD') return;
        $uri = isset($_SERVER['REQUEST_URI']) ? (string) $_SERVER['REQUEST_URI'] : '';
        $path = (string) wp_parse_url($uri, PHP_URL_PATH);
        $home_path = untrailingslashit((string) wp_parse_url(home_url('/'), PHP_URL_PATH));
        if ($path !== $home_path . '/llms.txt') return;
        $content = (string) get_option(self::OPT_LLMS, '');
        if ($content === '') return; // let Rank Math / Yoast / a physical file handle it
        status_header(200);
        header('Content-Type: text/plain; charset=utf-8');
        header('X-Content-Type-Options: nosniff');
        header('X-Robots-Tag: noindex');
        header('Cache-Control: public, max-age=300');
        if ($method === 'GET') echo $content;
        exit;
    }

    /* ---------- redirects ---------- */

    private static function redirect_map()
    {
        $m = get_option(self::OPT_REDIRECTS, array());
        return is_array($m) ? $m : array();
    }

    private static function host_key($h)
    {
        return preg_replace('/^www\./', '', strtolower((string) $h));
    }

    /** Lookup key for a path: decoded, lowercased, no trailing slash ("/" for root). */
    private static function path_key($path)
    {
        $p = rawurldecode((string) $path);
        $p = '/' . ltrim($p, '/');
        $p = strtolower(untrailingslashit($p));
        return $p === '' ? '/' : $p;
    }

    private static function clean_path($from)
    {
        $from = trim($from);
        if ($from === '') return new WP_Error('seo_agent_bad_from', 'from is required.', array('status' => 400));
        if (preg_match('#^https?://#i', $from)) {
            $from = (string) wp_parse_url($from, PHP_URL_PATH);
        }
        if ($from === '' || $from[0] !== '/') $from = '/' . $from;
        if (preg_match('/[\x00-\x1f\x7f]/', $from)) return new WP_Error('seo_agent_bad_from', 'from contains control characters.', array('status' => 400));
        $key = self::path_key($from);
        $home_key = self::path_key((string) wp_parse_url(home_url('/'), PHP_URL_PATH));
        if ($key === '/' || $key === $home_key) return new WP_Error('seo_agent_bad_from', 'Refusing to redirect the homepage.', array('status' => 400));
        if (preg_match('#/(wp-admin|wp-login\.php|wp-json|xmlrpc\.php|wp-cron\.php)(/|$)#', $key)) {
            return new WP_Error('seo_agent_bad_from', 'Refusing to redirect a WordPress system path.', array('status' => 400));
        }
        return $from;
    }

    public static function serve_redirects()
    {
        $map = self::redirect_map();
        if (!$map) return;
        $uri = isset($_SERVER['REQUEST_URI']) ? (string) $_SERVER['REQUEST_URI'] : '';
        $path = (string) wp_parse_url($uri, PHP_URL_PATH);
        $key = self::path_key($path);
        if (!isset($map[$key])) return;
        $rule = $map[$key];

        // If the Redirection plugin has an enabled rule for this URL, it is in charge.
        if (class_exists('Red_Item') && method_exists('Red_Item', 'get_for_matched_url')) {
            try {
                $items = Red_Item::get_for_matched_url($path);
                foreach ((array) $items as $item) {
                    if (is_object($item) && method_exists($item, 'is_enabled') && $item->is_enabled()) return;
                }
            } catch (\Throwable $e) {
                // ignore and serve our rule
            }
        }

        $code = (int) $rule['code'];
        if ($code === 410) {
            status_header(410);
            nocache_headers();
            header('X-Redirect-By: SEO Agent');
            exit;
        }
        $to = (string) $rule['to'];
        if ($to === '') return;
        // Loop guard: never redirect to the URL being requested.
        $to_path = (string) wp_parse_url($to, PHP_URL_PATH);
        if (self::host_key(wp_parse_url($to, PHP_URL_HOST)) === self::host_key(isset($_SERVER['HTTP_HOST']) ? $_SERVER['HTTP_HOST'] : '') && self::path_key($to_path) === $key) return;
        wp_redirect($to, $code, 'SEO Agent');
        exit;
    }

    /* =========================================================================================
     * Text files and cache purge
     * ======================================================================================= */

    private static function clean_text_file($content)
    {
        $c = is_scalar($content) ? (string) $content : '';
        $c = wp_check_invalid_utf8($c, true);
        $c = str_replace(array("\r\n", "\r", "\0"), array("\n", "\n", ''), $c);
        $c = preg_replace('/^\xEF\xBB\xBF/', '', $c);
        $c = trim($c);
        return $c === '' ? '' : $c . "\n";
    }

    /** Best-effort purge of every cache we know about. Returns the layers that were called. */
    public static function purge($id = 0, array $urls = array())
    {
        $done = array();
        $id = (int) $id;
        if ($id > 0) {
            clean_post_cache($id);
            $link = get_permalink($id);
            if ($link) $urls[] = $link;
            $done[] = 'object-cache';
        }
        // Map URLs to post IDs so per-post purges work for them too.
        $ids = $id > 0 ? array($id) : array();
        foreach ($urls as $u) {
            $pid = (int) url_to_postid($u);
            if ($pid > 0 && !in_array($pid, $ids, true)) {
                $ids[] = $pid;
                clean_post_cache($pid);
            }
        }
        $urls = array_values(array_unique(array_filter($urls)));

        if (function_exists('rocket_clean_post')) {
            foreach ($ids as $i) rocket_clean_post($i);
            if ($urls && function_exists('rocket_clean_files')) rocket_clean_files($urls);
            $done[] = 'wp-rocket';
        }
        if (defined('LSCWP_V')) {
            foreach ($ids as $i) do_action('litespeed_purge_post', $i);
            foreach ($urls as $u) do_action('litespeed_purge_url', $u);
            $done[] = 'litespeed';
        }
        if (function_exists('w3tc_flush_post')) {
            foreach ($ids as $i) w3tc_flush_post($i);
            if (function_exists('w3tc_flush_url')) foreach ($urls as $u) w3tc_flush_url($u);
            $done[] = 'w3tc';
        }
        if (function_exists('wp_cache_post_change')) {
            foreach ($ids as $i) wp_cache_post_change($i);
            $done[] = 'wp-super-cache';
        }
        if (function_exists('sg_cachepress_purge_cache')) {
            foreach ($urls as $u) sg_cachepress_purge_cache($u);
            $done[] = 'siteground';
        }
        if (class_exists('WpeCommon')) {
            if (method_exists('WpeCommon', 'purge_varnish_cache')) {
                foreach ($ids as $i) WpeCommon::purge_varnish_cache($i);
                if (!$ids) WpeCommon::purge_varnish_cache();
            }
            if (method_exists('WpeCommon', 'purge_memcached')) WpeCommon::purge_memcached();
            $done[] = 'wp-engine';
        }
        if (function_exists('wpfc_clear_post_cache_by_id')) {
            foreach ($ids as $i) wpfc_clear_post_cache_by_id($i);
            $done[] = 'wp-fastest-cache';
        }
        if (defined('NGINX_HELPER_BASENAME')) {
            foreach ($urls as $u) do_action('rt_nginx_helper_purge_url', $u);
            $done[] = 'nginx-helper';
        }
        /** Hook for site-specific CDNs. */
        do_action('seo_agent_purged', $id, $urls);
        return $done;
    }
}

SEO_Agent_Bridge::init();

endif;
