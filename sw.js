// sw.js
const CACHE_NAME = 'libero-v101';
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

// Переменная для хранения ID текущего открытого чата
let activeChatUid = null;

// Слушаем сообщения от нашего приложения (когда пользователь открывает/закрывает чат)
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SET_ACTIVE_CHAT') {
        activeChatUid = event.data.uid;
    }
});

self.addEventListener('push', function(event) {
    if (!event.data) return;
    
    const data = event.data.json();
    const senderUid = data.senderUid; 

    const promiseChain = clients.matchAll({
        type: 'window',
        includeUncontrolled: true
    }).then((windowClients) => {
        let isChatCurrentlyFocused = false;

        for (let i = 0; i < windowClients.length; i++) {
            const client = windowClients[i];
            
            // Если вкладка активна И пользователь сейчас в чате с тем, кто прислал сообщение
            if (client.visibilityState === 'visible' && activeChatUid === senderUid) {
                isChatCurrentlyFocused = true;
                break;
            }
        }

        // Если пользователь уже смотрит в этот чат — глушим уведомление
        if (isChatCurrentlyFocused) {
            return null;
        }

        // Иначе показываем пуш
        return self.registration.showNotification(data.title || 'Новое сообщение', {
            body: data.body || 'Вам прислали сообщение',
            icon: 'https://cdn-icons-png.flaticon.com/512/1041/1041916.png', // Добавлена иконка
            tag: senderUid, 
            data: { senderUid: senderUid }
        });
    });

    event.waitUntil(promiseChain);
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    
    // Используем scope регистрации как базовый URL
    const baseUrl = self.registration.scope;
    const senderUid = event.notification.data?.senderUid;

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
            // 1. Ищем уже открытую вкладку с приложением
            for (let i = 0; i < windowClients.length; i++) {
                const client = windowClients[i];
                if (client.url.includes(baseUrl)) {
                    client.focus(); // Разворачиваем браузер
                    
                    // Отправляем команду открыть чат
                    if (senderUid) {
                        client.postMessage({ type: 'OPEN_CHAT', senderUid: senderUid });
                    }
                    return;
                }
            }
            
            // 2. Если ни одной вкладки нет, открываем новую с ПРАВИЛЬНЫМ параметром URL
            const finalUrl = senderUid ? `${baseUrl}?chatWith=${senderUid}` : baseUrl;
            return clients.openWindow(finalUrl);
        })
    );
});