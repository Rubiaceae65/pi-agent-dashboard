// Minimal service worker for PWA installability.
// Passes all requests through to the network — no caching.
//
// /api/* requests are forwarded untouched: a network failure propagates as a
// real fetch rejection so callers can distinguish it from a server response.
// Only navigation/asset requests get the synthetic "Offline" fallback.
// See change: fix-openspec-profile-load-race.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // `/mobile/api/` is the phone client's prefixed alias of the same API.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/mobile/api/")) {
    // Pass through; do NOT mask failures as a fabricated 503.
    return; // let the browser perform the default network fetch
  }
  event.respondWith(
    fetch(event.request).catch(() => new Response("Offline", { status: 503 }))
  );
});
