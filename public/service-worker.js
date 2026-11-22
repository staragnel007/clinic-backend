/* MyClinicDesk service worker.
   Kept deliberately small: it makes the app installable and shows a friendly page when the
   internet is down. It never caches pages, API responses or patient data, so nothing stale
   or private is ever stored on the device by it. */
const OFFLINE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MyClinicDesk · Offline</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:#f6f3ee;color:#14231c;text-align:center;padding:24px}
.b{width:64px;height:64px;border-radius:14px;background:#1f6f50;margin:0 auto 18px;display:grid;place-items:center;color:#fff;font-size:40px;font-weight:700}
button{margin-top:16px;background:#1f6f50;color:#fff;border:0;border-radius:8px;padding:11px 22px;font:inherit;font-weight:600;cursor:pointer}</style></head>
<body><div><div class="b">+</div><h1 style="font-size:22px;margin:0 0 6px">You're offline</h1><p style="margin:0;color:#6c7b73">MyClinicDesk needs an internet connection.<br>Check your Wi-Fi or mobile data, then try again.</p>
<button onclick="location.reload()">Try again</button></div></body></html>`;
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", e => {
  if (e.request.mode !== "navigate") return; /* everything else goes straight to the network */
  e.respondWith(fetch(e.request).catch(() => new Response(OFFLINE, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } })));
});
