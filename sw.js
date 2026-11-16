// 서비스 워커: 앱 파일은 항상 네트워크에서 최신인지 확인하고(network-first), 오프라인일 때만 저장해 둔 사본을 쓴다.
// 이유: GitHub Pages는 파일마다 10분 캐시를 줘서, 배포 직후 새 파일과 옛 파일이 섞여 실행될 수 있었다
// (예: 새 업로드 화면 + 옛 채점 코드). 매번 서버에 확인(ETag)하면 바뀌지 않은 파일은 304로 빨리 끝나고,
// 바뀐 파일은 모두 새로 받으므로 한 번 로드할 때 파일 버전이 섞이지 않는다.
// 다른 출처(MediaPipe CDN, 폰트)는 건드리지 않는다.
const CACHE = 'strikecoach-app';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || req.headers.has('range')) return;
  e.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  try {
    // 페이지 이동 요청은 init을 붙여 다시 만들 수 없어서 URL로 요청한다.
    const res = await fetch(req.mode === 'navigate' ? req.url : req, { cache: 'no-cache', credentials: 'same-origin' });
    if (res.status === 200) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
    }
    return res;
  } catch (err) {
    const hit = await caches.match(req);
    if (hit) return hit;
    throw err;
  }
}
