/*
 * 교차 출처 격리(cross-origin isolation)용 서비스 워커
 * GitHub Pages는 응답 헤더를 바꿀 수 없어서, 이 페이지 범위의 같은 출처 응답에
 * COOP/COEP 헤더를 붙인다 → SharedArrayBuffer 사용 가능 → 멀티스레드 WASM으로 추론 속도 향상.
 * 다른 출처 요청(모델 다운로드 등)은 건드리지 않는다.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (new URL(req.url).origin !== self.location.origin) return;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  e.respondWith((async () => {
    const res = await fetch(req);
    if (res.status === 0 || res.type === 'opaque') return res;
    const headers = new Headers(res.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  })());
});
