// sw.js
const CACHE_NAME = 'libero-v121';
const ASSETS = [
  './',
  './index.html',
  './style.css?v=110',
  './scripts.js?v=110',
  './firebase.js'
];

let activeChatUid = null;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Кэширование ресурсов');
      return cache.addAll(ASSETS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[Service Worker] Удаление старого кэша:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') {
    return;
  }

  let requestToFetch = e.request;
  if (e.request.url.includes(self.location.origin) && e.request.mode !== 'navigate') {
    requestToFetch = new Request(e.request, { cache: 'no-cache' });
  }

  e.respondWith(
    fetch(requestToFetch)
      .then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(e.request, responseToCache);
          });
        }
        return response;
      })
      .catch(() => caches.match(e.request))
  );
});

self.addEventListener('message', (event) => {
  if (!event.data) return;

  if (event.data.type === 'SET_ACTIVE_CHAT') {
    activeChatUid = event.data.uid || null;
  }

  if (event.data.type === 'GET_ACTIVE_CHAT' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ activeChatUid });
  }
});

async function isActiveChatWithSender(senderUid) {
  if (!senderUid || activeChatUid !== senderUid) {
    return false;
  }

  const windowClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  return windowClients.some((client) => client.visibilityState === 'visible');
}

self.addEventListener('push', function(event) {
  if (!event.data) return;

  const data = event.data.json();
  const senderUid = data.senderUid;

  event.waitUntil(
    isActiveChatWithSender(senderUid).then((suppress) => {
      if (suppress) {
        return self.registration.getNotifications().then((notifications) => {
          notifications.forEach((notification) => {
            if (notification.tag === senderUid) {
              notification.close();
            }
          });
        });
      }

      const tag = senderUid || 'general';
      return self.registration.showNotification(data.title || 'Новое сообщение', {
        body: data.body || 'Вам прислали сообщение',
        icon: 'https://cdn-icons-png.flaticon.com/512/1041/1041916.png',
        tag: tag,
        renotify: true,
        data: { senderUid }
      });
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const baseUrl = new URL('./', self.registration.scope).href;
  const senderUid = event.notification.data?.senderUid;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.url.startsWith(baseUrl) || client.url.includes(self.location.origin)) {
          client.focus();
          if (senderUid) {
            client.postMessage({ type: 'OPEN_CHAT', senderUid });
          }
          return;
        }
      }

      return clients.openWindow(baseUrl).then((client) => {
        if (client && senderUid) {
          client.postMessage({ type: 'OPEN_CHAT', senderUid });
        }
      });
    })
  );
});
