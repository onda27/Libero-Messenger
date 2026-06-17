importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

// 2. Инициализируем проект внутри воркера (конфиг берем тот же самый)
firebase.initializeApp({
  apiKey: "AIzaSyDwfMxbM8DG7T3MllkjtYY1R2PPRYvfYHg",
  authDomain: "katik-messenger.firebaseapp.com",
  projectId: "katik-messenger",
  storageBucket: "katik-messenger.firebasestorage.app",
  messagingSenderId: "528309622983",
  appId: "1:528309622983:web:faa6c893c6a36013eac6e2" 
});

const messaging = firebase.messaging();

// 3. Вешаем слушатель на получение уведомлений, когда вкладка закрыта или свернута
messaging.onBackgroundMessage((payload) => {
  print('[Service Worker] Получено уведомление в фоне: ', payload);

  const notificationTitle = payload.notification.title || 'Новое сообщение';
  const notificationOptions = {
    body: payload.notification.body || '',
    icon: 'https://cdn-icons-png.flaticon.com/512/1041/1041916.png', // Твоя иконка мессенджера
    data: {
      url: payload.data?.url || '/' // Передаем ссылку для клика
    }
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});

const CACHE_NAME = 'libero-v65';
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

// Обработка клика по уведомлению
self.addEventListener('notificationclick', (event) => {
  // 1. Закрываем само уведомление
  event.notification.close();

  // 2. Получаем URL из данных уведомления (или дефолтный)
  const urlToOpen = event.notification.data?.url || '/';

  // 3. Ищем открытую вкладку или открываем новую
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Если вкладка с мессенджером уже где-то открыта (даже свернута) - фокусируемся на ней
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      // Если браузер был закрыт вообще - открываем новую вкладку
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});
