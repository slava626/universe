// Universe service worker.
// Scramjet (SW-based proxy) handles /scramjet/ requests when available; the
// server-side /proxy/ route is a separate HTTP fallback and is left alone here.
importScripts("/scram/scramjet.all.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

/* ---- Request inspector: forward request/response metadata to the page ---- */
let _seq = 0;
const _pending = Object.create(null); // real url -> queue of {id, ts}
function _broadcast(msg) {
  self.clients.matchAll({ includeUncontrolled: true }).then((cs) => cs.forEach((c) => c.postMessage(msg)));
}
function _hdrs(h) {
  const o = {};
  try {
    if (h && typeof h.forEach === "function") h.forEach((v, k) => (o[k] = v));
    else if (h) for (const k in h) o[k] = h[k];
  } catch {}
  return o;
}
scramjet.addEventListener("request", (e) => {
  try {
    const url = (e.url && e.url.href) || String(e.url || "");
    const id = ++_seq;
    (_pending[url] = _pending[url] || []).push({ id, ts: Date.now() });
    _broadcast({ kind: "req", id, url, method: e.method, destination: e.destination, reqHeaders: _hdrs(e.requestHeaders), ts: Date.now() });
  } catch {}
});
scramjet.addEventListener("handleResponse", (e) => {
  try {
    const url = (e.url && e.url.href) || String(e.url || "");
    const q = _pending[url];
    const p = q && q.shift();
    const headers = _hdrs(e.responseHeaders);
    _broadcast({ kind: "res", id: p ? p.id : null, url, status: e.status, statusText: e.statusText, headers, contentType: headers["content-type"] || "", ts: Date.now() });
  } catch {}
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    (async () => {
      await scramjet.loadConfig();
      if (scramjet.route(event)) return scramjet.fetch(event);
      return fetch(event.request);
    })()
  );
});
