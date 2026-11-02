// Makes 47 Studio installable. Always uses the network: the schedule must be live, never a cached copy.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
