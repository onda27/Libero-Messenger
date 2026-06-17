// sw.js
const CACHE_NAME = 'libero-v87';
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

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    const data = event.data ? event.data.json() : {};
    const senderUid = data.senderUid;

    // 1. Проверяем все открытые окна/вкладки приложения
    const windowClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    let isChatVisible = false;

    for (let client of windowClients) {
      // 2. Если вкладка активна (мы на ней) И URL указывает на чат с этим отправителем
      if (client.visibilityState === 'visible' && client.url.includes(`chatWith=${senderUid}`)) {
        isChatVisible = true;
        break;
      }
    }

    // 3. Если мы УЖЕ в чате с ним — просто глушим пуш (ничего не показываем)
    if (isChatVisible) {
      return;
    }

    // Иначе показываем уведомление
    const basePath = self.location.pathname.replace('sw.js', '');
    const chatUrl = senderUid 
      ? `${self.location.origin}${basePath}?chatWith=${senderUid}`
      : `${self.location.origin}${basePath}`;

    const options = {
      body: data.body,
      icon: 'https://cdn-icons-png.flaticon.com/512/1041/1041916.png',
      tag: senderUid, // Обязательно группируем по отправителю
      data: { url: chatUrl, senderUid: senderUid }
    };

    return self.registration.showNotification(data.title, options);
  })());
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