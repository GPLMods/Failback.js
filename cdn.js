// Cloudflare Worker CDN for GPL Mods
const BACKEND_URL = "https://gplmods.webredirect.org"; // <-- CHANGE THIS TO YOUR RENDER URL

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const backendUrl = new URL(BACKEND_URL);
    
    // Rewrite the request to point to your Render server
    url.hostname = backendUrl.hostname;
    url.protocol = backendUrl.protocol;

    // Determine if the request is for a static asset
    const isStaticAsset = url.pathname.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg|mp3|woff|woff2|ttf|json)$/i);

    // If it's NOT a static asset, we just pass the request through normally
    if (!isStaticAsset) {
      return fetch(url.toString(), request);
    }

    // --- STATIC ASSET CACHING LOGIC ---
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    
    // 1. Try to find the asset in Cloudflare's edge cache
    let response = await cache.match(cacheKey);

    if (!response) {
      // 2. If not in cache, fetch it from your Render server
      response = await fetch(cacheKey);

      // 3. Only cache successful responses (HTTP 200)
      if (response.status === 200) {
        // Clone the response so we can modify the headers
        response = new Response(response.body, response);
        
        // Force the cache to keep this file for 30 days
        response.headers.set("Cache-Control", "public, max-age=2592000, immutable");
        
        // Add CORS headers so your main domain is allowed to load these assets
        response.headers.set("Access-Control-Allow-Origin", "*");

        // 4. Put it in the Cloudflare Cache in the background
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
      }
    } else {
      // Add a header so you can see if it was a cache HIT or MISS in your browser dev tools
      response = new Response(response.body, response);
      response.headers.set("X-CDN-Cache-Status", "HIT");
      response.headers.set("Access-Control-Allow-Origin", "*");
    }

    return response;
  }
};
