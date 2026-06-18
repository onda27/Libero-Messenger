// scripts.js
import { auth, db, storage } from './firebase.js';
import { 
    signInWithEmailAndPassword, 
    createUserWithEmailAndPassword, 
    onAuthStateChanged, 
    signOut,
    updateEmail
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { 
    collection, 
    doc, 
    setDoc, 
    getDoc, 
    getDocs, 
    query, 
    where, 
    addDoc, 
    onSnapshot,
    deleteDoc,
    updateDoc,
    deleteField,
    limit
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
    ref,
    uploadBytes,
    getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

import { supabase } from './supabase.js';

function urlB64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

window.pendingChatUid = null;

/* === ЛОКАЛЬНОЕ СОСТОЯНИЕ === */
let currentUser = null; // { uid, username }
let currentChatFriend = null; // { uid, username, color }
let activeTab = 'login'; // 'login' | 'register'
let unsubscribeMessages = null;
let unsubscribeFriends = null;
let unsubscribeRequests = null;
let friendListeners = {};
let userColorsCache = {};
let userProfilesCache = {};
let pendingAttachments = [];
let profileModalUid = null;
let messageStore = new Map();

// Предопределенные цвета аватаров
const avatarsBg = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#0ea5e9", "#6366f1", "#a855f7", "#ec4899"];

const LOGIN_REGEX = /^[a-z0-9]{3,20}$/;

function normalizeLoginInput(value) {
    return value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
}

function isValidLogin(login) {
    return LOGIN_REGEX.test(login);
}

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function getUserColor(uid) {
    if (!userColorsCache[uid]) {
        let hash = 0;
        for (let i = 0; i < uid.length; i++) {
            hash = uid.charCodeAt(i) + ((hash << 5) - hash);
        }
        const index = Math.abs(hash) % avatarsBg.length;
        userColorsCache[uid] = avatarsBg[index];
    }
    return userColorsCache[uid];
}

function syncActiveChatToSW(uid = null) {
    if (!('serviceWorker' in navigator)) return;
    const payload = { type: 'SET_ACTIVE_CHAT', uid: uid || null };
    if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage(payload);
    }
    navigator.serviceWorker.ready.then((registration) => {
        if (registration.active) {
            registration.active.postMessage(payload);
        }
    }).catch(() => {});
}

function clearNotificationsBySender(senderUid) {
    if (!('serviceWorker' in navigator) || !senderUid) return;
    navigator.serviceWorker.ready.then((registration) => {
        return registration.getNotifications();
    }).then((notifications) => {
        notifications.forEach((notification) => {
            if (notification.tag === senderUid || notification.data?.senderUid === senderUid) {
                notification.close();
            }
        });
    }).catch((err) => console.error('Не удалось очистить уведомления:', err));
}

function applyAvatarToElement(element, user) {
    if (!element || !user) return;
    const letter = (user.username || '?').charAt(0).toUpperCase();
    element.innerHTML = '';
    if (user.avatarUrl) {
        const img = document.createElement('img');
        img.src = user.avatarUrl;
        img.alt = user.username || '';
        img.className = 'avatar-img';
        element.appendChild(img);
        element.style.background = 'transparent';
    } else {
        element.textContent = letter;
        element.style.background = getUserColor(user.uid);
    }
}

function buildAvatarContainerHtml(user) {
    const letter = (user.username || '?').charAt(0).toUpperCase();
    if (user.avatarUrl) {
        return `<img src="${user.avatarUrl}" class="avatar-img" alt="${user.username}">`;
    }
    return letter;
}

async function cacheUserProfile(uid) {
    const snap = await getDoc(doc(db, 'users', uid));
    if (!snap.exists()) return null;
    const profile = snap.data();
    userProfilesCache[uid] = profile;
    return profile;
}

async function sendPushToUser(receiverUid, body, senderUid) {
    const friendDoc = await getDoc(doc(db, 'users', receiverUid));
    if (!friendDoc.exists()) return;
    const pushSubStr = friendDoc.data().pushSubscription;
    if (!pushSubStr) return;

    await supabase.functions.invoke('send-push', {
        body: {
            subscription: JSON.parse(pushSubStr),
            title: currentUser.username,
            body,
            senderUid
        }
    });
}

/* === УВЕДОМЛЕНИЯ И ПОДТВЕРЖДЕНИЯ === */
function getNotificationContainer() {
    let container = document.getElementById('notification-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'notification-container';
        document.body.appendChild(container);
    }
    return container;
}

const customConfirmModal = document.getElementById('customConfirmModal');
const customConfirmTitle = document.getElementById('customConfirmTitle');
const customConfirmText = document.getElementById('customConfirmText');
const customConfirmYesBtn = document.getElementById('customConfirmYesBtn');
const customConfirmNoBtn = document.getElementById('customConfirmNoBtn');

let confirmCallback = null;

function showNotification(message, type = 'error', duration = 4000) {
    const container = getNotificationContainer();
    const text = String(message);

    const toast = document.createElement('div');
    toast.className = `toast-notification ${type}`;
    toast.textContent = text;

    const dismiss = () => {
        if (toast.classList.contains('hide')) return;
        toast.classList.add('hide');
        toast.addEventListener('animationend', () => toast.remove(), { once: true });
    };

    const timeout = setTimeout(dismiss, duration);
    toast.addEventListener('click', () => {
        clearTimeout(timeout);
        dismiss();
    });

    container.appendChild(toast);

    const visibleToasts = container.querySelectorAll('.toast-notification:not(.hide)');
    if (visibleToasts.length > 3) {
        visibleToasts[0].click();
    }
}

function getAuthErrorMessage(error) {
    const messages = {
        'auth/invalid-credential': 'Неверный логин или пароль.',
        'auth/wrong-password': 'Неверный пароль.',
        'auth/user-not-found': 'Пользователь с таким логином не найден.',
        'auth/email-already-in-use': 'Этот логин уже занят.',
        'auth/weak-password': 'Пароль слишком простой (минимум 6 символов).',
        'auth/too-many-requests': 'Слишком много попыток. Попробуйте позже.',
        'auth/network-request-failed': 'Нет соединения с интернетом.',
        'auth/invalid-email': 'Некорректный логин.',
        'auth/operation-not-allowed': 'Авторизация временно недоступна.',
        'permission-denied': 'Нет доступа к базе данных. Опубликуй правила из firestore.rules в Firebase Console.',
        'failed-precondition': 'Нужен индекс Firestore. Обнови правила и перезагрузи страницу.',
    };

    let code = error?.code;
    if (!code && error?.message) {
        const match = error.message.match(/\((auth\/[^)]+)\)/);
        if (match) code = match[1];
    }

    if (error?.message && error.message.includes('Missing or insufficient permissions')) {
        return messages['permission-denied'];
    }

    if (code && messages[code]) {
        return messages[code];
    }

    if (error?.message && !error.message.startsWith('Firebase:')) {
        return error.message;
    }

    return 'Произошла ошибка при авторизации.';
}

function showCustomConfirm(title, text, onConfirm, singleButtonMode = false) {
    if (!customConfirmModal) {
        if (onConfirm) onConfirm();
        return;
    }
    customConfirmTitle.textContent = title;
    customConfirmText.textContent = text;
    confirmCallback = onConfirm;
    
    if (singleButtonMode) {
        customConfirmNoBtn.style.display = 'none';
        customConfirmYesBtn.textContent = 'ОК';
    } else {
        customConfirmNoBtn.style.display = 'inline-block';
        customConfirmYesBtn.textContent = 'Да'; 
    }
    
    customConfirmModal.classList.add('active');
}

function hideCustomConfirm() {
    if (customConfirmModal) customConfirmModal.classList.remove('active');
    confirmCallback = null;
}

if (customConfirmYesBtn) {
    customConfirmYesBtn.addEventListener('click', () => {
        const cb = confirmCallback;
        hideCustomConfirm();
        if (cb) cb();
    });
}

if (customConfirmNoBtn) {
    customConfirmNoBtn.addEventListener('click', hideCustomConfirm);
}

if (customConfirmModal) {
    customConfirmModal.addEventListener('click', (e) => {
        if (e.target === customConfirmModal) hideCustomConfirm();
    });
}

window.showNotification = showNotification;
window.showCustomConfirm = showCustomConfirm;
window.alert = (msg) => showNotification(getAuthErrorMessage({ message: String(msg) }), 'error');

/* === УПРАВЛЕНИЕ АВТОРИЗАЦИЕЙ === */
const authContainer = document.getElementById('authContainer');
const mainAuthCard = document.getElementById('mainAuthCard');
const appContainer = document.getElementById('appContainer');

const tabLoginBtn = document.getElementById('tabLoginBtn');
const tabRegisterBtn = document.getElementById('tabRegisterBtn');
const authSubmitBtn = document.getElementById('authSubmitBtn');
const authEmailInput = document.getElementById('authEmail'); // Теперь тут Email
const authPasswordInput = document.getElementById('authPassword');

const usernameCard = document.getElementById('usernameCard'); // Вместо usernameModal
const setupUsernameInput = document.getElementById('setupUsernameInput');
const setupUsernameBtn = document.getElementById('setupUsernameBtn');

const logoutBtn = document.getElementById('logoutBtn');
const myProfileName = document.getElementById('myProfileName');

// Переключение табов
tabLoginBtn.addEventListener('click', () => {
    activeTab = 'login';
    tabLoginBtn.classList.add('active');
    tabRegisterBtn.classList.remove('active');
    authSubmitBtn.textContent = 'Войти';
});

tabRegisterBtn.addEventListener('click', () => {
    activeTab = 'register';
    tabRegisterBtn.classList.add('active');
    tabLoginBtn.classList.remove('active');
    authSubmitBtn.textContent = 'Зарегистрироваться';
});

// Сабмит формы авторизации (теперь чистый Email + Пароль)
authSubmitBtn.addEventListener('click', handleAuthSubmit);
authPasswordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        handleAuthSubmit();
    }
});

async function handleAuthSubmit() {
    const email = authEmailInput.value.trim();
    const password = authPasswordInput.value.trim();

    if (!email || !password) {
        showNotification('Пожалуйста, заполните все поля!', 'error');
        return;
    }

    if (password.length < 6) {
        showNotification('Пароль должен быть не менее 6 символов!', 'error');
        return;
    }

    authSubmitBtn.disabled = true;
    authSubmitBtn.textContent = 'Загрузка...';

    try {
        if (activeTab === 'login') {
            await signInWithEmailAndPassword(auth, email, password);
        } else {
            await createUserWithEmailAndPassword(auth, email, password);
        }
        // Успешный вход перехватит onAuthStateChanged ниже
    } catch (error) {
        console.error('Ошибка авторизации:', error);
        showNotification(getAuthErrorMessage(error), 'error');
        authSubmitBtn.disabled = false;
        authSubmitBtn.textContent = activeTab === 'login' ? 'Войти' : 'Зарегистрироваться';
    }
}

onAuthStateChanged(auth, async (firebaseUser) => {
    if (firebaseUser) {
        try {
            const userSnap = await getDoc(doc(db, 'users', firebaseUser.uid));
            
            if (userSnap.exists()) {
                currentUser = userSnap.data();
                myProfileName.textContent = currentUser.username;
                
                authContainer.classList.add('hidden');
                appContainer.classList.add('active');
                usernameCard.style.display = 'none'; 

                closeChat();
                startListeningRequestsAndFriends();
                startGlobalNotificationListener();
                setOnlineStatus(true);
                syncActiveChatToSW(null);
            } else {
                // Новый юзер: прячем вход, включаем шаг 2
                mainAuthCard.style.display = 'none'; 
                usernameCard.style.display = 'block'; 
                authContainer.classList.remove('hidden');
            }
        } catch (err) {
            console.error("Ошибка проверки профиля:", err);
            showNotification(getAuthErrorMessage(err), 'error');
            authSubmitBtn.disabled = false;
            authSubmitBtn.textContent = activeTab === 'login' ? 'Войти' : 'Зарегистрироваться';
            if (err?.code === 'permission-denied' || err?.message?.includes('Missing or insufficient permissions')) {
                await signOut(auth);
            }
        } finally {
            // ВАЖНО: Убираем экран загрузки, когда профиль успешно проверен/скачан
            document.body.classList.remove('auth-loading');
        }
    } else {
        currentUser = null;
        stopAllSubscriptions();
        
        authContainer.classList.remove('hidden');
        mainAuthCard.style.display = 'block'; 
        usernameCard.style.display = 'none';  
        
        authEmailInput.value = '';
        authPasswordInput.value = '';
        setupUsernameInput.value = '';
        
        document.getElementById('searchResults').innerHTML = '';
        document.getElementById('friendRequestsList').innerHTML = '';
        document.getElementById('chatList').innerHTML = '';
        closeChat();

        authSubmitBtn.disabled = false;
        authSubmitBtn.textContent = activeTab === 'login' ? 'Войти' : 'Зарегистрироваться';

        // ВАЖНО: Убираем экран загрузки для неавторизованного юзера (покажется форма входа)
        document.body.classList.remove('auth-loading');
    }
});

// === ЛОГИКА СОЗДАНИЯ НИКНЕЙМА ===
setupUsernameInput.addEventListener('input', () => {
    setupUsernameInput.value = normalizeLoginInput(setupUsernameInput.value);
});

setupUsernameBtn.addEventListener('click', async () => {
    const rawLogin = setupUsernameInput.value.trim();
    const firebaseUser = auth.currentUser;

    if (!firebaseUser) return;

    if (rawLogin.length < 3 || !isValidLogin(rawLogin)) {
        showNotification('Логин: только английские буквы и цифры (a-z, 0-9), от 3 до 20 символов.', 'error');
        return;
    }

    setupUsernameBtn.disabled = true;
    setupUsernameBtn.textContent = 'Проверка...';

    try {
        // 1. Проверяем, не занят ли логин
        const userRef = doc(db, 'users_by_username', rawLogin);
        const userSnap = await getDoc(userRef);

        if (userSnap.exists()) {
            throw new Error('Этот логин уже занят! Придумайте другой.');
        }

        // 2. Логин свободен, записываем данные в Firestore
        await setDoc(doc(db, 'users', firebaseUser.uid), {
            uid: firebaseUser.uid,
            username: rawLogin,
            email: firebaseUser.email || '',
            bio: '',
            avatarUrl: '',
            createdAt: Date.now()
        });

        await setDoc(userRef, { uid: firebaseUser.uid });

        // 3. Данные успешно записаны, обновляем UI
        currentUser = { uid: firebaseUser.uid, username: rawLogin, email: firebaseUser.email || '', bio: '', avatarUrl: '' };
        myProfileName.textContent = currentUser.username;
        
        usernameCard.style.display = 'none'; // Скрываем карточку шага 2
        authContainer.classList.add('hidden');
        appContainer.classList.add('active');
        
        startListeningRequestsAndFriends();
        startGlobalNotificationListener();

    } catch (error) {
        console.error('Ошибка сохранения логина:', error);
        showNotification(
            error.message?.includes('занят') ? error.message : getAuthErrorMessage(error),
            'error'
        );
    } finally {
        setupUsernameBtn.disabled = false;
        setupUsernameBtn.textContent = 'Сохранить и войти';
    }
});

logoutBtn.addEventListener('click', () => {
    if (typeof window.showCustomConfirm === 'function') {
        window.showCustomConfirm(
            'Выход из аккаунта',
            'Вы уверены, что хотите выйти из мессенджера?',
            async () => {
                try {
                    // но оставляем саму подписку в браузере живой для следующего аккаунта.
                    if (currentUser && currentUser.uid) {
                        try {
                            await updateDoc(doc(db, 'users', currentUser.uid), {
                                pushSubscription: deleteField()
                            });
                        } catch (error) {
                            console.error('Ошибка при удалении push-подписки из БД:', error);
                        }
                    }

                    // 1. Отписываемся от слушателей Firebase
                    if (unsubscribeMessages) { unsubscribeMessages(); unsubscribeMessages = null; }
                    if (unsubscribeFriends) { unsubscribeFriends(); unsubscribeFriends = null; }
                    if (unsubscribeRequests) { unsubscribeRequests = null; }

                    // 2. Выходим из Firebase
                    await signOut(auth);

                    window.history.pushState({}, '', window.location.pathname);
                    
                    // 3. Перезагружаем страницу для идеальной очистки интерфейса и памяти
                    window.location.reload();
                    
                } catch (err) {
                    console.error('Ошибка при выходе:', err);
                    showNotification(getAuthErrorMessage(err), 'error');
                }
            }
        );
    } else {
        signOut(auth)
            .then(() => window.location.reload())
            .catch(console.error);
    }
});

function stopAllSubscriptions() {
    if (unsubscribeMessages) unsubscribeMessages();
    if (unsubscribeFriends) unsubscribeFriends();
    if (unsubscribeRequests) unsubscribeRequests();
}

function stopFriendsListeners() {
    if (unsubscribeFriends) {
        unsubscribeFriends();
        unsubscribeFriends = null;
    }
}

/* === ПОИСК ПОЛЬЗОВАТЕЛЕЙ И ОТПРАВКА ЗАЯВОК === */
const userSearchInput = document.getElementById('userSearchInput');
const searchResults = document.getElementById('searchResults');

let searchTimeout = null;
userSearchInput.addEventListener('input', () => {
    const cleaned = normalizeLoginInput(userSearchInput.value);
    if (userSearchInput.value !== cleaned) {
        userSearchInput.value = cleaned;
    }
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(searchUsers, 500);
});

async function searchUsers() {
    const queryStr = userSearchInput.value.trim().toLowerCase();
    if (!queryStr) {
        searchResults.innerHTML = '';
        return;
    }

    if (queryStr === currentUser.username) {
        searchResults.innerHTML = '<div style="font-size:12px; color:var(--text-muted); text-align:center; padding:5px;">Это ваш логин</div>';
        return;
    }

    try {
        // Ищем пользователя с точным совпадением (или в диапазоне)
        const q = query(
            collection(db, 'users'), 
            where('username', '>=', queryStr), 
            where('username', '<=', queryStr + '\uf8ff'),
            limit(5)
        );
        const querySnapshot = await getDocs(q);

        searchResults.innerHTML = '';
        let foundAny = false;

        querySnapshot.forEach((docSnap) => {
            const foundUser = docSnap.data();
            if (foundUser.uid === currentUser.uid) return;

            foundAny = true;
            renderFoundUser(foundUser);
        });

        if (!foundAny) {
            searchResults.innerHTML = '<div style="font-size:12px; color:var(--text-muted); text-align:center; padding:5px;">Пользователь не найден</div>';
        }
    } catch (e) {
        console.error("Ошибка поиска:", e);
        showNotification('Ошибка при поиске пользователей.', 'error');
    }
}

async function renderFoundUser(user) {
    const div = document.createElement('div');
    div.className = 'found-user-item';
    div.innerHTML = `
        <span>${user.username}</span>
        <button class="friend-req-btn" id="btn-req-${user.uid}">Загрузка...</button>
    `;
    searchResults.appendChild(div);

    const btn = document.getElementById(`btn-req-${user.uid}`);

    // Проверяем статус отношений в реальном времени
    // Сначала ищем исходящий запрос
    const outQ = query(collection(db, 'friend_requests'), where('senderUid', '==', currentUser.uid), where('receiverUid', '==', user.uid));
    // Входящий запрос
    const inQ = query(collection(db, 'friend_requests'), where('senderUid', '==', user.uid), where('receiverUid', '==', currentUser.uid));
    
    const [outSnap, inSnap] = await Promise.all([getDocs(outQ), getDocs(inQ)]);

    let status = 'none'; // 'none' | 'pending_out' | 'pending_in' | 'accepted'
    let reqDocId = null;

    if (!outSnap.empty) {
        const req = outSnap.docs[0].data();
        status = req.status === 'accepted' ? 'accepted' : 'pending_out';
        reqDocId = outSnap.docs[0].id;
    } else if (!inSnap.empty) {
        const req = inSnap.docs[0].data();
        status = req.status === 'accepted' ? 'accepted' : 'pending_in';
        reqDocId = inSnap.docs[0].id;
    }

    if (status === 'accepted') {
        btn.textContent = 'Друзья';
        btn.classList.add('pending');
        btn.disabled = true;
    } else if (status === 'pending_out') {
        btn.textContent = 'Отправлено';
        btn.classList.add('pending');
        btn.disabled = true;
    } else if (status === 'pending_in') {
        btn.textContent = 'Принять';
        btn.onclick = async () => {
            btn.disabled = true;
            await updateDoc(doc(db, 'friend_requests', reqDocId), { status: 'accepted' });
            searchUsers();
        };
    } else {
        btn.textContent = 'Добавить';
        btn.onclick = async () => {
            btn.disabled = true;
            btn.textContent = 'Отправка...';
            await addDoc(collection(db, 'friend_requests'), {
                senderUid: currentUser.uid,
                senderUsername: currentUser.username,
                receiverUid: user.uid,
                receiverUsername: user.username,
                status: 'pending',
                createdAt: Date.now()
            });
            searchUsers();
        };
    }
}

// === СИСТЕМА ПРИСУТСТВИЯ (ONLINE/OFFLINE) ===
async function setOnlineStatus(isOnline) {
    if (!currentUser) return;
    try {
        await updateDoc(doc(db, 'users', currentUser.uid), {
            isOnline: isOnline,
            lastActive: Date.now()
        });
    } catch (e) {
        console.warn("Ошибка обновления статуса:", e);
    }
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        setOnlineStatus(true);
        syncActiveChatToSW(currentChatFriend?.uid || null);
        if (currentChatFriend) {
            clearNotificationsBySender(currentChatFriend.uid);
        }
    } else {
        setOnlineStatus(false);
    }
});

window.addEventListener('pagehide', () => {
    setOnlineStatus(false);
});

/* === РЕАЛ-ТАЙМ СЛУШАТЕЛИ ЗАЯВОК И ДРУЗЕЙ === */
const friendRequestsTitle = document.getElementById('friendRequestsTitle');
const friendRequestsList = document.getElementById('friendRequestsList');
const chatList = document.getElementById('chatList');

function startListeningRequestsAndFriends() {
    // 1. Слушаем входящие заявки в друзья (status: 'pending' и receiverUid == currentUser.uid)
    const requestsQuery = query(
        collection(db, 'friend_requests'),
        where('receiverUid', '==', currentUser.uid),
        where('status', '==', 'pending')
    );

    unsubscribeRequests = onSnapshot(requestsQuery, (snapshot) => {
        friendRequestsList.innerHTML = '';
        if (snapshot.empty) {
            friendRequestsTitle.style.display = 'none';
        } else {
            friendRequestsTitle.style.display = 'block';
            snapshot.forEach((docSnap) => {
                const req = docSnap.data();
                const reqId = docSnap.id;
                
                const div = document.createElement('div');
                div.className = 'friend-req-item';
                div.innerHTML = `
                    <span>${req.senderUsername}</span>
                    <div class="req-actions">
                        <button class="req-btn accept" id="accept-${reqId}">Да</button>
                        <button class="req-btn reject" id="reject-${reqId}">Нет</button>
                    </div>
                `;
                friendRequestsList.appendChild(div);

                document.getElementById(`accept-${reqId}`).onclick = () => acceptFriendRequest(reqId);
                document.getElementById(`reject-${reqId}`).onclick = () => rejectFriendRequest(reqId);
            });
        }
    });

    // 2. Слушаем список друзей (заявки accepted, где мы отправитель или получатель)
    const friendsSentQuery = query(
        collection(db, 'friend_requests'),
        where('senderUid', '==', currentUser.uid),
        where('status', '==', 'accepted')
    );
    const friendsReceivedQuery = query(
        collection(db, 'friend_requests'),
        where('receiverUid', '==', currentUser.uid),
        where('status', '==', 'accepted')
    );

    const friendsMap = new Map();

    function syncFriendsList() {
        renderFriendsList(Array.from(friendsMap.values()));
    }

    function applyFriendRequest(data) {
        if (data.senderUid === currentUser.uid) {
            friendsMap.set(data.receiverUid, { uid: data.receiverUid, username: data.receiverUsername });
        } else if (data.receiverUid === currentUser.uid) {
            friendsMap.set(data.senderUid, { uid: data.senderUid, username: data.senderUsername });
        }
    }

    stopFriendsListeners();

    const unsubFriendsSent = onSnapshot(friendsSentQuery, (snapshot) => {
        snapshot.docChanges().forEach((change) => {
            const data = change.doc.data();
            if (change.type === 'removed') {
                friendsMap.delete(data.receiverUid);
            } else {
                applyFriendRequest(data);
            }
        });
        syncFriendsList();
    });

    const unsubFriendsReceived = onSnapshot(friendsReceivedQuery, (snapshot) => {
        snapshot.docChanges().forEach((change) => {
            const data = change.doc.data();
            if (change.type === 'removed') {
                friendsMap.delete(data.senderUid);
            } else {
                applyFriendRequest(data);
            }
        });
        syncFriendsList();
    });

    unsubscribeFriends = () => {
        unsubFriendsSent();
        unsubFriendsReceived();
    };
}

async function acceptFriendRequest(reqId) {
    await updateDoc(doc(db, 'friend_requests', reqId), { status: 'accepted' });
}

async function rejectFriendRequest(reqId) {
    await deleteDoc(doc(db, 'friend_requests', reqId));
}

function renderFriendsList(friends) {

    Object.values(friendListeners).forEach(unsub => unsub());
    friendListeners = {}; // Очищаем объект

    chatList.innerHTML = '';
    if (friends.length === 0) {
        chatList.innerHTML = '<div style="color:var(--text-muted); font-size:13px; text-align:center; padding:20px;">У вас пока нет друзей. Найдите их по логину выше!</div>';
        return;
    }

    friends.forEach(friend => {
        cacheUserProfile(friend.uid).then((profile) => {
            if (profile) {
                friend.avatarUrl = profile.avatarUrl || '';
                friend.bio = profile.bio || '';
            }
        });

        const color = getUserColor(friend.uid);
        const avatarContent = buildAvatarContainerHtml(friend);

        const div = document.createElement('div');
        div.id = `chat-item-${friend.uid}`;
        div.className = `chat-item ${currentChatFriend && currentChatFriend.uid === friend.uid ? 'active' : ''}`;
        div.onclick = () => selectFriendChat(friend);
        
        div.innerHTML = `
            <div class="avatar-container">
                <div class="avatar" id="list-avatar-${friend.uid}" style="background:${friend.avatarUrl ? 'transparent' : color}">${avatarContent}</div>
                <div class="online-dot" id="dot-${friend.uid}"></div>
            </div>
            <div class="chat-info">
                <div class="chat-row-1">
                    <div class="chat-name">${friend.username}</div>
                    <div id="badge-container-${friend.uid}"></div>
                </div>
                <div class="chat-row-2">
                    <div class="chat-last-msg" id="last-msg-${friend.uid}">Нажмите для общения</div>
                </div>
            </div>
        `;
        chatList.appendChild(div);

        listenLastMessage(friend.uid);
    });

    if (window.pendingChatUid) {
        const targetFriend = friends.find(f => f.uid === window.pendingChatUid);
        if (targetFriend) {
            selectFriendChat(targetFriend);
        }
        window.pendingChatUid = null;
    }
}

function listenLastMessage(friendUid) {
    // 1. Слушаем счетчик непрочитанных сообщений, отправленных НАМ
    const unreadQuery = query(
        collection(db, 'messages'),
        where('receiverUid', '==', currentUser.uid),
        where('senderUid', '==', friendUid),
        where('isRead', '==', false)
    );
    
    const unsubUnread = onSnapshot(unreadQuery, (snapshot) => {
        const badgeContainer = document.getElementById(`badge-container-${friendUid}`);
        if (!badgeContainer) return;
        
        if (snapshot.size > 0) {
            badgeContainer.innerHTML = `<span class="unread-badge">${snapshot.size}</span>`;
            // Опционально: делаем шрифт последнего сообщения жирным
            const lastMsgText = document.getElementById(`last-msg-${friendUid}`);
            if (lastMsgText) lastMsgText.style.fontWeight = 'bold';
        } else {
            badgeContainer.innerHTML = '';
            const lastMsgText = document.getElementById(`last-msg-${friendUid}`);
            if (lastMsgText) lastMsgText.style.fontWeight = 'normal';
        }
    });

    // 2. Слушаем честный онлайн статус друга
    const unsubOnline = onSnapshot(doc(db, 'users', friendUid), (docSnap) => {
        if(docSnap.exists()){
            const userData = docSnap.data();
            userProfilesCache[friendUid] = userData;
            const isOnline = userData.isOnline;
            const dot = document.getElementById(`dot-${friendUid}`);
            if(dot) {
                dot.className = `online-dot ${isOnline ? 'active' : ''}`;
            }
            const listAvatar = document.getElementById(`list-avatar-${friendUid}`);
            if (listAvatar) {
                applyAvatarToElement(listAvatar, userData);
            }
        }
    });

    // 3. СОХРАНЯЕМ отписки в объект, чтобы потом их очистить в renderFriendsList
    friendListeners[friendUid] = () => {
        unsubUnread();
        unsubOnline();
    };
}

/* === ВЫБОР ДИАЛОГА И СИСТЕМА СООБЩЕНИЙ === */
const noChatSelectedScreen = document.getElementById('noChatSelectedScreen');
const chatHeader = document.getElementById('chatHeader');
const messagesArea = document.getElementById('messagesArea');
const chatInputArea = document.getElementById('chatInputArea');

const activeName = document.getElementById('activeName');
const activeAvatar = document.getElementById('activeAvatar');
const activeStatus = document.getElementById('activeStatus');

const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const micBtn = document.getElementById('micBtn');
const attachBtn = document.getElementById('attachBtn');
const attachInput = document.getElementById('attachInput');
const attachPreview = document.getElementById('attachPreview');
const themeToggleBtn = document.getElementById('themeToggleBtn');
const backBtnMobile = document.getElementById('backBtnMobile');
const headerUser = document.querySelector('.header-user');
const profileModal = document.getElementById('profileModal');
const profileCloseBtn = document.getElementById('profileCloseBtn');
const profileAvatarLetter = document.getElementById('profileAvatarLetter');
const profileAvatarImg = document.getElementById('profileAvatarImg');
const profileAvatarEdit = document.getElementById('profileAvatarEdit');
const profileAvatarInput = document.getElementById('profileAvatarInput');
const profileUsername = document.getElementById('profileUsername');
const profileStatusText = document.getElementById('profileStatusText');
const profileEmail = document.getElementById('profileEmail');
const profileBio = document.getElementById('profileBio');
const profileSaveBtn = document.getElementById('profileSaveBtn');
const profileRemoveFriendBtn = document.getElementById('profileRemoveFriendBtn');
const infoBio = document.getElementById('infoBio');
const infoOpenProfileBtn = document.getElementById('infoOpenProfileBtn');
const infoRemoveFriendBtn = document.getElementById('infoRemoveFriendBtn');

function closeChat() {
    syncActiveChatToSW(null);
    currentChatFriend = null;
    clearPendingAttachments();
    noChatSelectedScreen.style.display = 'flex';
    chatHeader.style.display = 'none';
    messagesArea.style.display = 'none';
    chatInputArea.style.display = 'none';
    if (attachPreview) attachPreview.style.display = 'none';
    if (unsubscribeMessages) unsubscribeMessages();
    messageStore.clear();
}

function selectFriendChat(friend) {
    syncActiveChatToSW(friend.uid);
    clearNotificationsBySender(friend.uid);
    currentChatFriend = friend;

    noChatSelectedScreen.style.display = 'none';
    chatHeader.style.display = 'flex';
    messagesArea.style.display = 'flex';
    chatInputArea.style.display = 'flex';

    activeName.textContent = friend.username;
    applyAvatarToElement(activeAvatar, friend);

    if (window.unsubscribeActiveStatus) window.unsubscribeActiveStatus();
    window.unsubscribeActiveStatus = onSnapshot(doc(db, 'users', friend.uid), (docSnap) => {
        if (docSnap.exists()) {
            const userData = docSnap.data();
            userProfilesCache[friend.uid] = userData;
            currentChatFriend = { ...currentChatFriend, ...userData };
            const isOnline = userData.isOnline;
            activeStatus.textContent = isOnline ? 'в сети' : 'не в сети';
            activeStatus.style.color = isOnline ? 'var(--primary)' : 'var(--text-muted)';
            document.getElementById('activeOnline').className = `online-dot ${isOnline ? 'active' : ''}`;
            applyAvatarToElement(activeAvatar, userData);
            if (infoBio) infoBio.textContent = userData.bio || '—';
        }
    });

    document.querySelectorAll('.chat-item').forEach(el => el.classList.remove('active'));
    const currentChatItem = document.getElementById(`chat-item-${friend.uid}`);
    if (currentChatItem) currentChatItem.classList.add('active');
    
    listenToMessages();

    if (window.innerWidth <= 768) {
        document.getElementById('sidebar').classList.add('hidden-mobile');
    }
}

// Слушатель инпута ввода
messageInput.addEventListener('input', () => {
    autoExpand(messageInput);
    updateSendButtonVisibility();
});

messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

sendBtn.addEventListener('click', sendMessage);

function autoExpand(field) {
    field.style.height = 'inherit';
    field.style.height = (field.scrollHeight) + 'px';
}

async function sendMessage() {
    const text = messageInput.value.trim();
    if (!currentChatFriend) return;

    if (pendingAttachments.length > 0) {
        await sendPendingAttachments(text);
        return;
    }

    if (!text) return;

    messageInput.value = '';
    messageInput.style.height = 'inherit';
    micBtn.style.display = 'flex';
    sendBtn.style.display = 'none';

    try {
        await addDoc(collection(db, 'messages'), {
            senderUid: currentUser.uid,
            receiverUid: currentChatFriend.uid,
            type: 'text',
            text,
            createdAt: Date.now(),
            isRead: false
        });
        await sendPushToUser(currentChatFriend.uid, text, currentUser.uid);
    } catch (e) {
        console.error("Ошибка отправки сообщения:", e);
        showNotification(getAuthErrorMessage(e), 'error');
    }
}

function renderAttachmentPreview() {
    if (!attachPreview) return;
    attachPreview.innerHTML = '';
    if (pendingAttachments.length === 0) {
        attachPreview.style.display = 'none';
        return;
    }
    attachPreview.style.display = 'flex';
    pendingAttachments.forEach((item, index) => {
        const wrap = document.createElement('div');
        wrap.className = 'attach-preview-item';
        wrap.innerHTML = `<img src="${item.previewUrl}" alt=""><button type="button" data-index="${index}">×</button>`;
        wrap.querySelector('button').onclick = () => {
            URL.revokeObjectURL(item.previewUrl);
            pendingAttachments.splice(index, 1);
            renderAttachmentPreview();
            updateSendButtonVisibility();
        };
        attachPreview.appendChild(wrap);
    });
}

function clearPendingAttachments() {
    pendingAttachments.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    pendingAttachments = [];
    renderAttachmentPreview();
    if (attachInput) attachInput.value = '';
    updateSendButtonVisibility();
}

function updateSendButtonVisibility() {
    const hasContent = messageInput.value.trim() || pendingAttachments.length > 0;
    micBtn.style.display = hasContent ? 'none' : 'flex';
    sendBtn.style.display = hasContent ? 'flex' : 'none';
}

async function sendPendingAttachments(caption = '') {
    if (!currentChatFriend || pendingAttachments.length === 0) return;
    const files = [...pendingAttachments];
    clearPendingAttachments();
    messageInput.value = '';
    messageInput.style.height = 'inherit';

    for (const item of files) {
        try {
            const path = `chat/${currentUser.uid}/${Date.now()}_${item.file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
            const storageRef = ref(storage, path);
            await uploadBytes(storageRef, item.file);
            const imageUrl = await getDownloadURL(storageRef);
            await addDoc(collection(db, 'messages'), {
                senderUid: currentUser.uid,
                receiverUid: currentChatFriend.uid,
                type: 'image',
                imageUrl,
                text: caption || '',
                createdAt: Date.now(),
                isRead: false
            });
            await sendPushToUser(currentChatFriend.uid, caption || '📷 Фото', currentUser.uid);
        } catch (e) {
            console.error('Ошибка отправки фото:', e);
            showNotification('Не удалось отправить фото.', 'error');
        }
    }
    updateSendButtonVisibility();
}

if (attachBtn && attachInput) {
    attachBtn.addEventListener('click', () => attachInput.click());
    attachInput.addEventListener('change', () => {
        const files = Array.from(attachInput.files || []);
        files.forEach((file) => {
            if (!file.type.startsWith('image/')) return;
            pendingAttachments.push({ file, previewUrl: URL.createObjectURL(file) });
        });
        attachInput.value = '';
        renderAttachmentPreview();
        updateSendButtonVisibility();
    });
}

function listenToMessages() {
    if (unsubscribeMessages) unsubscribeMessages();
    messagesArea.innerHTML = '';
    messageStore.clear();
    ensureTypingIndicator();

    const getDateId = (timestamp) => 'date-' + new Date(timestamp).toLocaleDateString('ru-RU').replace(/\./g, '-');

    function buildMessageNode(msg) {
        const msgTimestamp = msg.createdAt || Date.now();
        const date = new Date(msgTimestamp);
        const timeString = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        const isMyMessage = msg.senderUid === currentUser.uid;
        const divMsg = document.createElement('div');
        divMsg.id = `msg-${msg.id}`;
        divMsg.setAttribute('data-timestamp', msgTimestamp);
        divMsg.className = `message ${isMyMessage ? 'msg-out' : 'msg-in'}`;

        const tickIcon = msg.isRead ? '#icon-check-double' : '#icon-check';
        const tickClass = msg.isRead ? 'msg-status read' : 'msg-status';
        const imagePart = msg.type === 'image' && msg.imageUrl
            ? `<img src="${msg.imageUrl}" class="msg-attachment" alt="Фото">`
            : '';
        const textPart = msg.text ? `<div>${escapeHtml(msg.text)}</div>` : '';

        divMsg.innerHTML = `
            <div class="msg-bubble">
                ${imagePart}
                ${textPart}
                <div class="msg-meta">
                    <span>${timeString}</span>
                    ${isMyMessage ? `<span class="${tickClass}"><svg><use href="${tickIcon}"></use></svg></span>` : ''}
                </div>
            </div>
        `;
        return divMsg;
    }

    function rebuildMessagesUI() {
        const typingIndicator = ensureTypingIndicator();
        messagesArea.querySelectorAll('.message, .date-divider').forEach((node) => node.remove());

        const sorted = Array.from(messageStore.values()).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        let lastDateId = null;
        const unreadIds = [];

        sorted.forEach((msg) => {
            const msgTimestamp = msg.createdAt || Date.now();
            const dateId = getDateId(msgTimestamp);
            if (dateId !== lastDateId) {
                lastDateId = dateId;
                const dateString = new Date(msgTimestamp).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
                const divDivider = document.createElement('div');
                divDivider.className = 'date-divider';
                divDivider.id = dateId;
                divDivider.innerHTML = `<span>${dateString}</span>`;
                messagesArea.insertBefore(divDivider, typingIndicator);
            }

            messagesArea.insertBefore(buildMessageNode(msg), typingIndicator);

            if (msg.senderUid !== currentUser.uid && !msg.isRead) {
                unreadIds.push(msg.id);
            }
        });

        scrollToBottom();

        if (unreadIds.length > 0) {
            unreadIds.forEach((id) => {
                updateDoc(doc(db, 'messages', id), { isRead: true }).catch(console.error);
            });
            if (currentChatFriend) {
                clearNotificationsBySender(currentChatFriend.uid);
            }
        }
    }

    function applySnapshot(snapshot) {
        snapshot.docChanges().forEach((change) => {
            const msg = { ...change.doc.data(), id: change.doc.id };
            if (change.type === 'removed') {
                messageStore.delete(msg.id);
            } else {
                messageStore.set(msg.id, msg);
            }
        });
        rebuildMessagesUI();
    }

    function ensureTypingIndicator() {
        let typingIndicator = document.getElementById('typingIndicator');
        if (!typingIndicator) {
            typingIndicator = document.createElement('div');
            typingIndicator.className = 'typing-indicator';
            typingIndicator.id = 'typingIndicator';
            typingIndicator.innerHTML = '<div class="dot"></div><div class="dot"></div><div class="dot"></div>';
            messagesArea.appendChild(typingIndicator);
        }
        return typingIndicator;
    }

    const sentQuery = query(
        collection(db, 'messages'),
        where('senderUid', '==', currentUser.uid),
        where('receiverUid', '==', currentChatFriend.uid)
    );
    const receivedQuery = query(
        collection(db, 'messages'),
        where('senderUid', '==', currentChatFriend.uid),
        where('receiverUid', '==', currentUser.uid)
    );

    let messagesLoadErrorShown = false;
    const onMessagesError = (err) => {
        console.error('Ошибка загрузки сообщений:', err);
        if (messagesLoadErrorShown) return;
        messagesLoadErrorShown = true;
        showNotification(getAuthErrorMessage(err), 'error');
    };

    const unsubSent = onSnapshot(sentQuery, applySnapshot, onMessagesError);
    const unsubReceived = onSnapshot(receivedQuery, applySnapshot, onMessagesError);

    unsubscribeMessages = () => {
        unsubSent();
        unsubReceived();
        messageStore.clear();
    };
}

function appendDividerNode(dateString) {
    const div = document.createElement('div');
    div.className = 'date-divider';
    div.innerHTML = `<span>${dateString}</span>`;
    messagesArea.appendChild(div); 
}

function appendMessageNode(text, isOut, time, isRead) {
    const div = document.createElement('div');
    div.className = `message ${isOut ? 'msg-out' : 'msg-in'}`;
    
    const tickIcon = isRead ? '#icon-check-double' : '#icon-check';
    const tickClass = isRead ? 'msg-status read' : 'msg-status';
    
    div.innerHTML = `
        <div class="msg-bubble">
            ${text}
            <div class="msg-meta">
                <span>${time}</span>
                ${isOut ? `<span class="${tickClass}"><svg><use href="${tickIcon}"></use></svg></span>` : ''}
            </div>
        </div>
    `;
    messagesArea.appendChild(div); 
}

function scrollToBottom() {
    messagesArea.scrollTop = messagesArea.scrollHeight;
}

/* === UI ПЕРЕКЛЮЧАТЕЛИ И ЗВОНКИ === */
const html = document.documentElement;
const themeIcon = document.getElementById('themeIcon');

const savedTheme = localStorage.getItem('libero_theme') || 'dark';
setTheme(savedTheme);

themeToggleBtn.addEventListener('click', () => {
    const newTheme = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    setTheme(newTheme);
});

function setTheme(themeName) {
    html.setAttribute('data-theme', themeName);
    localStorage.setItem('libero_theme', themeName);
    if(themeIcon) {
        themeIcon.innerHTML = `<use href="${themeName === 'dark' ? '#icon-sun' : '#icon-moon'}"></use>`;
    }
}

backBtnMobile.addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('hidden-mobile');
    closeChat(); 
});

const infoToggleBtn = document.getElementById('infoToggleBtn');
infoToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const panel = document.getElementById('infoPanel');
    
    if (currentChatFriend) {
        document.getElementById('infoName').textContent = currentChatFriend.username;
        applyAvatarToElement(document.getElementById('infoAvatar'), currentChatFriend);
        document.getElementById('infoStatus').textContent = currentChatFriend.isOnline ? 'В сети' : 'Не в сети';
        if (infoBio) infoBio.textContent = currentChatFriend.bio || '—';
        if (infoRemoveFriendBtn) infoRemoveFriendBtn.style.display = 'block';
    }
    
    panel.classList.toggle('open');
});

if (headerUser) {
    headerUser.addEventListener('click', () => {
        if (currentChatFriend) openProfile(currentChatFriend.uid);
    });
}

if (myProfileName) {
    myProfileName.addEventListener('click', () => {
        if (currentUser) openProfile(currentUser.uid);
    });
}

if (infoOpenProfileBtn) {
    infoOpenProfileBtn.addEventListener('click', () => {
        if (currentChatFriend) openProfile(currentChatFriend.uid);
    });
}

if (infoRemoveFriendBtn) {
    infoRemoveFriendBtn.addEventListener('click', () => {
        if (currentChatFriend) confirmRemoveFriend(currentChatFriend);
    });
}

async function findFriendRequestId(friendUid) {
    const sentQ = query(
        collection(db, 'friend_requests'),
        where('senderUid', '==', currentUser.uid),
        where('receiverUid', '==', friendUid),
        where('status', '==', 'accepted')
    );
    const receivedQ = query(
        collection(db, 'friend_requests'),
        where('senderUid', '==', friendUid),
        where('receiverUid', '==', currentUser.uid),
        where('status', '==', 'accepted')
    );
    const [sentSnap, receivedSnap] = await Promise.all([getDocs(sentQ), getDocs(receivedQ)]);
    if (!sentSnap.empty) return sentSnap.docs[0].id;
    if (!receivedSnap.empty) return receivedSnap.docs[0].id;
    return null;
}

async function removeFriend(friendUid) {
    const reqId = await findFriendRequestId(friendUid);
    if (!reqId) {
        showNotification('Не удалось найти связь с пользователем.', 'error');
        return;
    }
    await deleteDoc(doc(db, 'friend_requests', reqId));
    if (currentChatFriend && currentChatFriend.uid === friendUid) {
        closeChat();
        document.getElementById('infoPanel')?.classList.remove('open');
    }
    closeProfileModal();
    showNotification('Пользователь удалён из друзей.', 'success');
}

function confirmRemoveFriend(friend) {
    showCustomConfirm(
        'Удалить из друзей',
        `Удалить ${friend.username} из списка друзей?`,
        () => removeFriend(friend.uid)
    );
}

function closeProfileModal() {
    profileModal?.classList.remove('active');
    profileModalUid = null;
}

async function openProfile(uid) {
    if (!uid) return;
    const profile = userProfilesCache[uid] || await cacheUserProfile(uid);
    if (!profile) {
        showNotification('Профиль не найден.', 'error');
        return;
    }

    profileModalUid = uid;
    const isOwnProfile = uid === currentUser.uid;
    const isFriend = uid !== currentUser.uid;

    profileUsername.textContent = profile.username;
    profileStatusText.textContent = profile.isOnline ? 'в сети' : 'не в сети';
    profileEmail.value = profile.email || auth.currentUser?.email || '';
    profileBio.value = profile.bio || '';

    if (profile.avatarUrl) {
        profileAvatarImg.src = profile.avatarUrl;
        profileAvatarImg.style.display = 'block';
        profileAvatarLetter.style.display = 'none';
    } else {
        profileAvatarImg.style.display = 'none';
        profileAvatarLetter.style.display = 'flex';
        applyAvatarToElement(profileAvatarLetter, profile);
    }

    profileEmail.readOnly = !isOwnProfile;
    profileBio.readOnly = !isOwnProfile;
    profileSaveBtn.style.display = isOwnProfile ? 'block' : 'none';
    profileAvatarEdit.style.display = isOwnProfile ? 'flex' : 'none';
    profileRemoveFriendBtn.style.display = isFriend ? 'block' : 'none';

    profileModal.classList.add('active');
}

profileCloseBtn?.addEventListener('click', closeProfileModal);
profileModal?.addEventListener('click', (e) => {
    if (e.target === profileModal) closeProfileModal();
});

profileSaveBtn?.addEventListener('click', async () => {
    if (!currentUser || profileModalUid !== currentUser.uid) return;
    profileSaveBtn.disabled = true;
    profileSaveBtn.textContent = 'Сохранение...';

    try {
        const nextEmail = profileEmail.value.trim();
        const nextBio = profileBio.value.trim().slice(0, 280);

        if (nextEmail && auth.currentUser && nextEmail !== auth.currentUser.email) {
            await updateEmail(auth.currentUser, nextEmail);
        }

        await updateDoc(doc(db, 'users', currentUser.uid), {
            email: nextEmail,
            bio: nextBio
        });

        currentUser = { ...currentUser, email: nextEmail, bio: nextBio };
        userProfilesCache[currentUser.uid] = { ...currentUser };
        myProfileName.textContent = currentUser.username;
        showNotification('Профиль сохранён.', 'success');
        closeProfileModal();
    } catch (error) {
        console.error('Ошибка сохранения профиля:', error);
        showNotification(getAuthErrorMessage(error), 'error');
    } finally {
        profileSaveBtn.disabled = false;
        profileSaveBtn.textContent = 'Сохранить';
    }
});

profileAvatarInput?.addEventListener('change', async () => {
    const file = profileAvatarInput.files?.[0];
    profileAvatarInput.value = '';
    if (!file || !currentUser || profileModalUid !== currentUser.uid) return;
    if (!file.type.startsWith('image/')) {
        showNotification('Можно загрузить только изображение.', 'error');
        return;
    }

    try {
        const path = `avatars/${currentUser.uid}/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const storageRef = ref(storage, path);
        await uploadBytes(storageRef, file);
        const avatarUrl = await getDownloadURL(storageRef);
        await updateDoc(doc(db, 'users', currentUser.uid), { avatarUrl });
        currentUser = { ...currentUser, avatarUrl };
        userProfilesCache[currentUser.uid] = { ...currentUser };
        openProfile(currentUser.uid);
        showNotification('Аватар обновлён.', 'success');
    } catch (error) {
        console.error('Ошибка загрузки аватара:', error);
        showNotification('Не удалось загрузить аватар.', 'error');
    }
});

profileRemoveFriendBtn?.addEventListener('click', () => {
    if (!profileModalUid || profileModalUid === currentUser.uid) return;
    confirmRemoveFriend({ uid: profileModalUid, username: profileUsername.textContent });
});

/* === СИСТЕМА ЗВОНКОВ === */
const callModal = document.getElementById('callModal');
const callVoiceBtn = document.getElementById('callVoiceBtn');
const callVideoBtn = document.getElementById('callVideoBtn');
const callRejectBtn = document.getElementById('callRejectBtn');
const callAcceptBtn = document.getElementById('callAcceptBtn');
const videoCallFS = document.getElementById('videoCallFS');
const videoCallEndBtn = document.getElementById('videoCallEndBtn');

callVoiceBtn.addEventListener('click', () => startCall('voice'));
callVideoBtn.addEventListener('click', () => startCall('video'));
callRejectBtn.addEventListener('click', endCall);
callAcceptBtn.addEventListener('click', acceptCall);
videoCallEndBtn.addEventListener('click', endCall);

let currentCallType = '';

function startCall(type) {
    if (!currentChatFriend) return;
    currentCallType = type;
    
    document.getElementById('callTypeText').textContent = type === 'video' ? 'Исходящий видеозвонок' : 'Исходящий аудиозвонок';
    document.getElementById('callName').textContent = currentChatFriend.username;
    document.getElementById('callStatus').textContent = 'Гудки...';
    
    const av = document.getElementById('callAvatar');
    av.textContent = currentChatFriend.username.charAt(0).toUpperCase();
    av.style.background = getUserColor(currentChatFriend.uid);
    
    callModal.classList.add('active');

    setTimeout(() => {
        if(!callModal.classList.contains('active')) return;
        if(type === 'video') {
            acceptVideoCall();
        } else {
            document.getElementById('callStatus').textContent = 'Разговор: 00:01';
        }
    }, 3000);
}

function acceptVideoCall() {
    callModal.classList.remove('active');
    videoCallFS.classList.add('active');
}

function acceptCall() {
    document.getElementById('callStatus').textContent = 'Разговор: 00:01';
}

function endCall() {
    callModal.classList.remove('active');
    videoCallFS.classList.remove('active');
}

// Функция очистки уведомлений КОНКРЕТНОГО пользователя — см. clearNotificationsBySender выше

// Глобальный слушатель новых сообщений
// ВСТАВЬ СЮДА СВОЙ ПУБЛИЧНЫЙ КЛЮЧ ИЗ ШАГА 1
const VAPID_PUBLIC_KEY = 'BPhHDbs6dN2oztI8bOFA7ifoWdEbcMFeqZjZ4eRFEQnW8X7BqbJ3Y9AO506IgFKTDGuzloxBRnktDnmYywbjHXU'; 

async function startGlobalNotificationListener() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

    // Спрашиваем разрешение
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;

    try {
        const registration = await navigator.serviceWorker.ready;
        
        // Проверяем, есть ли уже подписка
        let subscription = await registration.pushManager.getSubscription();
        
        // Если нет — подписываем устройство на серверные пуши
        if (!subscription) {
            subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC_KEY)
            });
        }

        // Сохраняем подписку в профиль юзера в Firestore
        if (currentUser && currentUser.uid) {
            await updateDoc(doc(db, 'users', currentUser.uid), {
                pushSubscription: JSON.stringify(subscription)
            });
        }
    } catch (err) {
        console.error('Ошибка подписки на Push:', err);
    }

    // Твой старый код для отслеживания непрочитанных сообщений, если приложение открыто
    const unreadQuery = query(
        collection(db, 'messages'),
        where('receiverUid', '==', currentUser.uid),
        where('isRead', '==', false)
    );
    onSnapshot(unreadQuery, (snapshot) => {
        // Оставляем пустой или добавляем логику бейджей/звука внутри открытого приложения
        // Локальные пуши отсюда мы убираем, чтобы они не дублировались с серверными
    });
}

window.forceOpenChat = async (uid) => {
    // Защита от пустых вызовов
    if (!uid) return;

    // Если профиль еще не прогрузился (например, при открытии свернутого приложения), 
    // ставим чат в очередь, он откроется сам после логина
    if (!currentUser) {
        window.pendingChatUid = uid;
        return;
    }

    try {
        const friendSnap = await getDoc(doc(db, 'users', uid));
        if (friendSnap.exists()) {
            const data = friendSnap.data();
            selectFriendChat({ 
                uid,
                username: data.username,
                avatarUrl: data.avatarUrl || '',
                bio: data.bio || ''
            });
        }
    } catch (error) {
        console.error('Ошибка принудительного открытия чата:', error);
    }
};

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'OPEN_CHAT') {
            const senderUid = event.data.senderUid;
            if (senderUid) {
                // Вызываем нашу новую функцию напрямую, без костылей с .click()
                window.forceOpenChat(senderUid);
            }
        }
    });
}