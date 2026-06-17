// sw.js
const CACHE_NAME = 'libero-v100';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './scripts.js',
  './firebase.js'
];

// Установка SW и кэширование ресурсов
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Кэширование ресурсов');
      return cache.addAll(ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Активация SW и удаление старых кэшей
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

// Стратегия: Network First (Сначала сеть, с переходом на кэш при офлайне)
// Это идеальное решение для GitHub Pages, чтобы пользователи сразу получали свежие обновления,
// а при отсутствии сети мессенджер продолжал открываться из кэша.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') {
    return;
  }

  // РЕШЕНИЕ ПРОБЛЕМЫ ДВОЙНОГО КЭШИРОВАНИЯ:
  // Если запрос идет к нашему домену (локальные ресурсы) и это не навигация по страницам,
  // создаем новый запрос с флагом cache: 'no-cache', чтобы принудительно лететь на сервер мимо HTTP-кэша.
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
      .catch(() => caches.match(e.request)) // Если интернета нет — берем из SW-кэша
  );
});

// В sw.js

self.addEventListener('push', function(event) {
    if (!event.data) return;
    
    const data = event.data.json();
    const senderUid = data.senderUid; // Убедись, что Supabase передает senderUid

    const promiseChain = clients.matchAll({
        type: 'window',
        includeUncontrolled: true
    }).then((windowClients) => {
        let isChatCurrentlyFocused = false;

        for (let i = 0; i < windowClients.length; i++) {
            const client = windowClients[i];
            
            // Если вкладка активна (видна пользователю)
            if (client.visibilityState === 'visible') {
                const url = new URL(client.url);
                // Проверяем, совпадает ли параметр chatWith с тем, кто прислал пуш
                if (url.searchParams.get('chatWith') === senderUid) {
                    isChatCurrentlyFocused = true;
                    break;
                }
            }
        }

        // Если пользователь уже смотрит в этот чат — ничего не показываем!
        if (isChatCurrentlyFocused) {
            return null;
        }

        // В противном случае показываем стандартное уведомление
        return self.registration.showNotification(data.title, {
            body: data.body,
            icon: '/path-to-your-icon.png',
            tag: senderUid, // tag заменяет старые пуши от этого же юзера новыми
            data: { senderUid: senderUid }
        });
    });

    event.waitUntil(promiseChain);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const urlToOpen = event.notification.data?.url || self.location.origin;
  const senderUid = event.notification.data?.senderUid;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Ищем открытую вкладку
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.url.includes(self.location.origin)) {
          client.focus(); // Разворачиваем браузер
          
          // ТИХО отправляем команду в приложение сменить чат (БЕЗ ПЕРЕЗАГРУЗКИ)
          if (senderUid && 'postMessage' in client) {
            client.postMessage({ type: 'OPEN_CHAT', senderUid: senderUid });
          }
          return;
        }
      }
      // Если ни одной вкладки нет (браузер закрыт), тогда открываем новую с нуля
      return clients.openWindow(urlToOpen);
    })
  );
});