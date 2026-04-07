const CACHE_NAME = 'sync-metronome-v3';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/app.js',
    '/style.css',
    '/icon.svg',
    '/manifest.json'
];

// インストール: 静的資源をキャッシュ
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(STATIC_ASSETS);
        })
    );
    self.skipWaiting();
});

// アクティベーション: 古いキャッシュを削除
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter((key) => key !== CACHE_NAME)
                    .map((key) => caches.delete(key))
            );
        })
    );
    self.clients.claim();
});

// フェッチ: Cache First（静的資源）、Network First（その他）
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Socket.io の通信はキャッシュしない
    if (url.pathname.startsWith('/socket.io')) {
        return;
    }

    // Google Fonts はネットワーク優先（オフライン時はキャッシュ）
    if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
        event.respondWith(
            fetch(event.request).then((response) => {
                const clone = response.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                return response;
            }).catch(() => caches.match(event.request))
        );
        return;
    }

    // 静的資源: Cache First
    event.respondWith(
        caches.match(event.request).then((cached) => {
            if (cached) {
                // バックグラウンドで更新（stale-while-revalidate）
                fetch(event.request).then((response) => {
                    if (response && response.status === 200) {
                        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response));
                    }
                }).catch(() => { });
                return cached;
            }
            return fetch(event.request);
        })
    );
});
