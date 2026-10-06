/**
 * Cloudflare Worker CDN for GPL Mods (Failback & Asset Distribution)
 *
 * Full Owner Control Features:
 * - Edge Static Asset Caching (30-day max-age, immutable)
 * - Instant Cache Clear (Purge) via /purge or /?purge=1
 * - Connect / Disconnect Toggle (Live Active vs Bypass Mode)
 * - Live Status Diagnostic Endpoint (/cdn-status)
 * - Global CORS Headers
 */

// Upstream Backend Target (Configurable via Cloudflare Worker Environment Variable: BACKEND_URL)
const DEFAULT_BACKEND_URL = "https://gplmods.webredirect.org";
const DEFAULT_PURGE_SECRET = "gplmods-dns-secret";

// In-memory worker connection state (Can also be overridden via request header/parameter or KV)
let isCdnConnected = true;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PURGE",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Purge-Key, X-CDN-Bypass, X-Requested-With",
  "Access-Control-Max-Age": "86400"
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const backendUrlStr = (env && env.BACKEND_URL) || DEFAULT_BACKEND_URL;
    const purgeSecret = (env && env.PURGE_SECRET) || DEFAULT_PURGE_SECRET;
    const backendUrl = new URL(backendUrlStr);

    // ==========================================
    // 1. LIVE CDN STATUS ENDPOINT (/cdn-status)
    // ==========================================
    if (url.pathname === "/cdn-status" || url.pathname === "/api/cdn-status") {
      return new Response(JSON.stringify({
        success: true,
        service: "GPLMods Cloudflare CDN Worker",
        status: isCdnConnected ? "connected" : "disconnected",
        mode: isCdnConnected ? "active_caching" : "bypass_mode",
        backendUrl: backendUrlStr,
        edgeCacheSupported: true,
        timestamp: new Date().toISOString(),
        version: "2.5.0"
      }, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      });
    }

    // ==========================================
    // 2. OWNER CONTROL ENDPOINT (/cdn-control)
    // ==========================================
    if (url.pathname === "/cdn-control") {
      const authKey = url.searchParams.get("key") || request.headers.get("x-purge-key");
      if (authKey !== purgeSecret) {
        return new Response(JSON.stringify({ success: false, error: "Unauthorized control request" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS }
        });
      }

      const action = url.searchParams.get("action");
      if (action === "disconnect") {
        isCdnConnected = false;
        return new Response(JSON.stringify({
          success: true,
          status: "disconnected",
          mode: "bypass_mode",
          message: "Cloudflare CDN disconnected. Edge caching bypassed.",
          timestamp: new Date().toISOString()
        }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS }
        });
      } else if (action === "connect") {
        isCdnConnected = true;
        return new Response(JSON.stringify({
          success: true,
          status: "connected",
          mode: "active_caching",
          message: "Cloudflare CDN connected. Edge caching is active.",
          timestamp: new Date().toISOString()
        }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS }
        });
      } else if (action === "status") {
        return new Response(JSON.stringify({
          success: true,
          status: isCdnConnected ? "connected" : "disconnected",
          mode: isCdnConnected ? "active_caching" : "bypass_mode"
        }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS }
        });
      }

      return new Response(JSON.stringify({ success: false, error: "Invalid action. Use connect or disconnect." }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      });
    }

    // ==========================================
    // 3. CACHE CLEAR / PURGE ENDPOINT (/purge)
    // ==========================================
    const isPurgeRequest = request.method === "PURGE" ||
      url.pathname === "/purge" ||
      url.searchParams.get("purge") === "1";

    if (isPurgeRequest) {
      const authKey = url.searchParams.get("key") || request.headers.get("x-purge-key");
      if (authKey !== purgeSecret) {
        return new Response(JSON.stringify({ success: false, error: "Unauthorized purge request" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS }
        });
      }

      const cache = caches.default;
      const targetPath = url.searchParams.get("path");
      let deleted = true;

      if (targetPath) {
        const targetUrl = new URL(targetPath, url.origin);
        deleted = await cache.delete(new Request(targetUrl.toString()));
      } else {
        // Purge root & general cache key
        const rootKey = new Request(new URL("/", url.origin).toString());
        await cache.delete(rootKey);
      }

      return new Response(JSON.stringify({
        success: true,
        message: targetPath ? `Purged cache for ${targetPath}` : "Cloudflare CDN edge cache purged successfully.",
        purged: deleted,
        timestamp: new Date().toISOString()
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      });
    }

    // Check if CDN is bypassed or disconnected
    const isExplicitBypass = url.searchParams.get("cdn_bypass") === "1" ||
      request.headers.get("x-cdn-bypass") === "1" ||
      !isCdnConnected;

    // Rewrite the request to point to your backend server
    url.hostname = backendUrl.hostname;
    url.protocol = backendUrl.protocol;
    if (backendUrl.port) url.port = backendUrl.port;

    // Determine if the request is for a static asset
    const isStaticAsset = url.pathname.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg|mp3|woff|woff2|ttf|json|webp|avif)$/i);

    // If CDN is disconnected or bypassed, fetch directly without edge caching
    if (isExplicitBypass || !isStaticAsset) {
      let response = await fetch(url.toString(), request);
      response = new Response(response.body, response);
      response.headers.set("X-CDN-Status", isExplicitBypass ? "BYPASSED_DISCONNECTED" : "PASSTHROUGH_DYNAMIC");
      response.headers.set("X-CDN-Mode", isCdnConnected ? "connected" : "disconnected");
      Object.entries(CORS_HEADERS).forEach(([k, v]) => response.headers.set(k, v));
      return response;
    }

    // ==========================================
    // 4. STATIC ASSET CACHING LOGIC (CONNECTED)
    // ==========================================
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);

    // 1. Try to find the asset in Cloudflare's edge cache
    let response = await cache.match(cacheKey);

    if (!response) {
      // 2. Fetch from upstream backend
      response = await fetch(cacheKey);

      // 3. Only cache successful responses (HTTP 200)
      if (response.status === 200) {
        response = new Response(response.body, response);
        // Force the cache to keep this file for 30 days
        response.headers.set("Cache-Control", "public, max-age=2592000, immutable");
        response.headers.set("X-CDN-Cache-Status", "MISS");
        response.headers.set("X-CDN-Mode", "connected");
        Object.entries(CORS_HEADERS).forEach(([k, v]) => response.headers.set(k, v));

        // 4. Put into Cloudflare Cache in background
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
      }
    } else {
      // Cache HIT
      response = new Response(response.body, response);
      response.headers.set("X-CDN-Cache-Status", "HIT");
      response.headers.set("X-CDN-Mode", "connected");
      Object.entries(CORS_HEADERS).forEach(([k, v]) => response.headers.set(k, v));
    }

    return response;
  }
};
