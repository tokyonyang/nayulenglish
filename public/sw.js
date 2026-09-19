// Minimal service worker — just enough for Android's "Install app" prompt
// to appear (Chrome requires a registered SW with a fetch handler). It
// doesn't cache anything itself; the app is small and API-driven, so
// offline support isn't attempted here.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
  // Pass-through — required for install-ability, but no caching logic.
});
