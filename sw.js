// sw.js
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

// Инициализация Firebase внутри Service Worker
// Данные конфигурации (apiKey, authDomain и т.д.) возьми из своего файла firebase.js
firebase.initializeApp({
  apiKey: "ТВОЙ_API_KEY",
  authDomain: "ТВОЙ_PROJECT.firebaseapp.com",
  projectId: "ТВОЙ_PROJECT_ID",
  storageBucket: "ТВОЙ_PROJECT.appspot.com",
  messagingSenderId: "ТВОЙ_SENDER_ID",
  appId: "ТВОЙ_APP_ID"
});

const messaging = firebase.messaging();

// Логика, которая сработает, когда Firebase пришлет фоновый Push, 
// даже если PWA полностью закрыто на айфоне!
messaging.onBackgroundMessage((payload) => {
  console.log('[sw.js] Получено фоновое сообщение: ', payload);

  const notificationTitle = payload.notification?.title || 'Новое сообщение';
  const notificationOptions = {
    body: payload.notification?.body || '',
    icon: 'https://cdn-icons-png.flaticon.com/512/1041/1041916.png', // Твоя иконка
    tag: payload.data?.senderUid || 'chat-notification',
    data: {
      url: self.location.origin
    }
  };

  // Жесткое требование iOS: оборачивать в event.waitUntil
  return self.registration.showNotification(notificationTitle, notificationOptions);
});

// --- СТАРЫЙ КОД КЭШИРОВАНИЯ ИЗ ТВОЕГО SW.JS (НЕ УДАЛЯЕМ ЕГО) ---
const CACHE_NAME = 'libero-v56';
const ASSETS = ['./', './index.html', './style.css', './scripts.js', './firebase.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((key) => {
      if (key !== CACHE_NAME) return caches.delete(key);
    }))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  let requestToFetch = e.request;
  if (e.request.url.includes(self.location.origin) && e.request.mode !== 'navigate') {
    requestToFetch = new Request(e.request, { cache: 'no-cache' });
  }
  e.respondWith(
    fetch(requestToFetch)
      .then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, responseToCache));
        }
        return response;
      })
      .catch(() => caches.match(e.request))
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const urlToOpen = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.url.includes(self.location.origin) && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(urlToOpen);
    })
  );
});