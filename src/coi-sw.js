// Adds the COOP/COEP headers the WebAssembly backup writer needs when the
// host cannot send them (GitHub Pages). Registering this worker and reloading
// once makes the tutorial page cross-origin isolated.

const SCOPE = '/arkhamrevived/ps3-tutorial/';

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(SCOPE)) return;

  event.respondWith((async () => {
    const response = await fetch(request);
    // Worker and wasm responses need Cross-Origin-Resource-Policy under
    // COEP: require-corp, so stamp every response in scope. The in-scope
    // assets are small (the video lives outside this path), so buffering is
    // cheaper than reasoning about a wrapped stream's content headers.
    const body = await response.blob();
    const headers = new Headers(response.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  })());
});
