// sw.js
const CACHE_NAME = 'libero-v84';
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

// Слушаем входящие пуш-уведомления от сервера (Supabase)
self.addEventListener('push', (event) => {
  if (!event.data) return;

  event.waitUntil((async () => {
    const data = event.data.json();
    
    // 1. Получаем список всех открытых вкладок нашего сайта
    const clientList = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    
    // 2. Проверяем, сфокусирована ли вкладка, где открыт именно этот чат
    let isChatActive = false;
    for (const client of clientList) {
      if (client.focused && client.url.includes(`chatWith=${data.senderUid}`)) {
        isChatActive = true;
        break;
      }
    }

    // 3. Если чат активен — уведомление не показываем
    if (isChatActive) return;

    // 4. Если чат не активен — показываем
    const basePath = self.location.pathname.replace('sw.js', '');
    const chatUrl = data.senderUid 
      ? `${self.location.origin}${basePath}?chatWith=${data.senderUid}`
      : `${self.location.origin}${basePath}`;

    const options = {
      body: data.body,
      icon: 'https://cdn-icons-png.flaticon.com/512/1041/1041916.png',
      tag: data.senderUid, // тег позволяет группировать уведомления от одного человека
      data: { url: chatUrl }
    };

    self.registration.showNotification(data.title, options);
  })());
});

// Обработка клика по уведомлению
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  // Достаем сформированный URL из данных пуша
  const urlToOpen = event.notification.data?.url || self.location.origin;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Ищем, открыта ли вкладка нашего приложения
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        
        // Если вкладка открыта — перенаправляем её на URL с нужным чатом и фокусируемся
        if (client.url.includes(self.location.origin) && 'navigate' in client) {
          client.navigate(urlToOpen);
          return client.focus();
        }
      }
      
      // Если приложение вообще закрыто — открываем новую вкладку сразу с нужным чатом
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});