// Universe service worker — proxying is handled server-side (/proxy/), so this
// SW just claims clients and stays out of the way. It never intercepts /proxy/.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (u.pathname.startsWith("/proxy/")) return; // let it hit the network/server
  // default: pass through
});
