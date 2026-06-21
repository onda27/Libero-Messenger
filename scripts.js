// scripts.js
import { auth, db, firebaseConfig } from './firebase.js';
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
    limit,
    writeBatch
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

import { supabase } from './supabase.js';
import { CryptoManager } from './crypto.js';
import { uploadEncryptedChatImage, downloadAndDecryptChatImage, uploadEncryptedAvatar, downloadAndDecryptAvatar } from './storage.js';

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

    // Handle encrypted avatar
    if (user.avatarStoragePath && user.encKeyB64) {
        const img = document.createElement('img');
        img.className = 'avatar-img avatar-img-loading';
        img.alt = user.username || '';
        element.appendChild(img);
        element.style.background = getUserColor(user.uid);

        // Decrypt async
        downloadAndDecryptAvatar(user.avatarStoragePath, user.encKeyB64)
            .then(blob => {
                img.src = URL.createObjectURL(blob);
                img.classList.remove('avatar-img-loading');
                element.style.background = 'transparent';
            })
            .catch(err => {
                console.error('Failed to decrypt avatar for', user.uid, err);
                img.remove();
                element.textContent = letter;
                element.style.background = getUserColor(user.uid);
            });
    } else if (user.avatarUrl) {
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
    // For encrypted avatars, we'll show the letter initially and decrypt async via applyAvatarToElement
    if (user.avatarStoragePath && user.encKeyB64) {
        return letter; // Will be replaced by async decryption in listenLastMessage
    }
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
                startIncomingCallListener();
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
            avatarStoragePath: '',
            encKeyB64: '',
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
        startIncomingCallListener();

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
    if (incomingCallUnsubscribe) { incomingCallUnsubscribe(); incomingCallUnsubscribe = null; }
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

/**
 * Reliably mark user as offline using navigator.sendBeacon + Firestore REST API.
 * sendBeacon is guaranteed to complete even after page unload.
 */
function sendOfflineBeacon() {
    if (!currentUser || !auth.currentUser) return;
    const projectId = firebaseConfig.projectId;
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${currentUser.uid}?updateMask.fieldPaths=isOnline&updateMask.fieldPaths=lastActive`;
    // Use cached token — getIdToken(false) won't trigger a network refresh
    const tokenPromise = auth.currentUser.getIdToken(false);
    // We can't await in beforeunload, so we fire-and-forget
    tokenPromise.then(token => {
        const body = JSON.stringify({
            fields: {
                isOnline: { booleanValue: false },
                lastActive: { integerValue: Date.now() }
            }
        });
        // Try fetch with keepalive first (more reliable than sendBeacon for auth headers)
        fetch(url, {
            method: 'PATCH',
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: body,
            keepalive: true
        }).catch(() => {});
    }).catch(() => {});
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        setOnlineStatus(true);
        syncActiveChatToSW(currentChatFriend?.uid || null);
        if (currentChatFriend) {
            clearNotificationsBySender(currentChatFriend.uid);
        }
        // Hide PiP mini when returning to tab during call (full UI is still there)
        if (isInCall) {
            pipMiniCall.style.display = 'none';
        }
    } else {
        setOnlineStatus(false);
        // Show mini PiP when tab is hidden during call (but keep full UI in DOM)
        if (isInCall) {
            pipMiniCall.style.display = 'flex';
            const pipAvatar = document.getElementById('pipMiniAvatar');
            const pipName = document.getElementById('pipMiniName');
            if (currentChatFriend) {
                pipAvatar.textContent = currentChatFriend.username.charAt(0).toUpperCase();
                pipAvatar.style.background = getUserColor(currentChatFriend.uid);
                pipName.textContent = currentChatFriend.username;
            }
        }
    }
});

// Reliable offline status when page/tab is closed
window.addEventListener('beforeunload', () => {
    sendOfflineBeacon();
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
    }, (err) => console.warn('Friend requests listener error:', err));

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
                // If chat is open with removed friend, close it
                if (currentChatFriend && currentChatFriend.uid === data.receiverUid) {
                    closeChat();
                    document.getElementById('infoPanel')?.classList.remove('open');
                }
            } else {
                applyFriendRequest(data);
            }
        });
        syncFriendsList();
    }, (err) => console.warn('Friends sent listener error:', err));

    const unsubFriendsReceived = onSnapshot(friendsReceivedQuery, (snapshot) => {
        snapshot.docChanges().forEach((change) => {
            const data = change.doc.data();
            if (change.type === 'removed') {
                friendsMap.delete(data.senderUid);
                // If chat is open with removed friend, close it
                if (currentChatFriend && currentChatFriend.uid === data.senderUid) {
                    closeChat();
                    document.getElementById('infoPanel')?.classList.remove('open');
                }
            } else {
                applyFriendRequest(data);
            }
        });
        syncFriendsList();
    }, (err) => console.warn('Friends received listener error:', err));

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
                friend.avatarStoragePath = profile.avatarStoragePath || '';
                friend.encKeyB64 = profile.encKeyB64 || '';
                friend.bio = profile.bio || '';
            }
        });

        const color = getUserColor(friend.uid);
        const avatarContent = buildAvatarContainerHtml(friend);
        const hasAvatar = friend.avatarUrl || (friend.avatarStoragePath && friend.encKeyB64);

        const div = document.createElement('div');
        div.id = `chat-item-${friend.uid}`;
        div.className = `chat-item ${currentChatFriend && currentChatFriend.uid === friend.uid ? 'active' : ''}`;
        div.onclick = () => selectFriendChat(friend);
        
        div.innerHTML = `
            <div class="avatar-container">
                <div class="avatar" id="list-avatar-${friend.uid}" style="background:${hasAvatar ? 'transparent' : color}">${avatarContent}</div>
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

        // If avatar is encrypted, trigger async decryption via applyAvatarToElement
        if (friend.avatarStoragePath && friend.encKeyB64) {
            const listAvatar = document.getElementById(`list-avatar-${friend.uid}`);
            if (listAvatar) applyAvatarToElement(listAvatar, friend);
        }

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
            // Encrypt + upload to Supabase
            const { path: storagePath, encKeyB64 } = await uploadEncryptedChatImage(
                item.file, currentUser.uid, currentChatFriend.uid
            );

            // Store the encrypted path + key in the Firestore message
            await addDoc(collection(db, 'messages'), {
                senderUid: currentUser.uid,
                receiverUid: currentChatFriend.uid,
                type: 'image',
                imageUrl: storagePath,  // now a Supabase storage path, not a public URL
                encKeyB64,             // encryption key so receiver can decrypt
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

        // Call event messages (WhatsApp-style)
        if (msg.type === 'call') {
            const divMsg = document.createElement('div');
            divMsg.id = `msg-${msg.id}`;
            divMsg.setAttribute('data-timestamp', msgTimestamp);
            divMsg.className = 'message msg-call-event';
            const callTypeIcon = msg.callType === 'video' ? '🎥' : '📞';
            let callText = '';
            if (msg.callStatus === 'missed') {
                callText = `Пропущенный ${msg.callType === 'video' ? 'видеозвонок' : 'звонок'}`;
            } else if (msg.callStatus === 'rejected') {
                callText = `Отклонённый ${msg.callType === 'video' ? 'видеозвонок' : 'звонок'}`;
            } else if (msg.callStatus === 'answered') {
                callText = `${msg.callType === 'video' ? 'Видеозвонок' : 'Аудиозвонок'} · ${msg.callDuration || ''}`;
            } else {
                callText = `${msg.callType === 'video' ? 'Видеозвонок' : 'Аудиозвонок'}`;
            }
            divMsg.innerHTML = `<div class="msg-call"><span class="msg-call-icon">${callTypeIcon}</span><span class="msg-call-text">${callText}</span><span class="msg-call-time">${timeString}</span></div>`;
            return divMsg;
        }

        const divMsg = document.createElement('div');
        divMsg.id = `msg-${msg.id}`;
        divMsg.setAttribute('data-timestamp', msgTimestamp);
        divMsg.className = `message ${isMyMessage ? 'msg-out' : 'msg-in'}`;

        const tickIcon = msg.isRead ? '#icon-check-double' : '#icon-check';
        const tickClass = msg.isRead ? 'msg-status read' : 'msg-status';

        // Handle encrypted image messages
        let imagePart = '';
        if (msg.type === 'image' && msg.imageUrl) {
            if (msg.encKeyB64) {
                // Encrypted image — create a placeholder and decrypt async
                const imgId = `enc-img-${msg.id}`;
                imagePart = `<img id="${imgId}" class="msg-attachment msg-attachment-loading" alt="Фото">`;
                // Async decrypt
                downloadAndDecryptChatImage(msg.imageUrl, msg.encKeyB64)
                    .then(blob => {
                        const imgEl = document.getElementById(imgId);
                        if (imgEl) {
                            imgEl.src = URL.createObjectURL(blob);
                            imgEl.classList.remove('msg-attachment-loading');
                        }
                    })
                    .catch(err => {
                        console.error('Failed to decrypt image:', err);
                        const imgEl = document.getElementById(imgId);
                        if (imgEl) {
                            imgEl.alt = 'Не удалось расшифровать';
                            imgEl.classList.remove('msg-attachment-loading');
                            imgEl.classList.add('msg-attachment-error');
                        }
                    });
            } else {
                // Legacy: unencrypted Firebase URL (backwards compatibility)
                imagePart = `<img src="${msg.imageUrl}" class="msg-attachment" alt="Фото">`;
            }
        }

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
    const sidebar = document.getElementById('sidebar');
    
    if (currentChatFriend) {
        document.getElementById('infoName').textContent = currentChatFriend.username;
        applyAvatarToElement(document.getElementById('infoAvatar'), currentChatFriend);
        document.getElementById('infoStatus').textContent = currentChatFriend.isOnline ? 'В сети' : 'Не в сети';
        if (infoBio) infoBio.textContent = currentChatFriend.bio || '—';
        if (infoRemoveFriendBtn) infoRemoveFriendBtn.style.display = 'block';
    }
    
    const isOpening = !panel.classList.contains('open');
    panel.classList.toggle('open');

    // On mobile, hide sidebar when info panel opens
    if (isOpening && window.innerWidth <= 768) {
        sidebar.classList.add('hidden-mobile');
    }
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

    // Close chat locally if open with this friend
    if (currentChatFriend && currentChatFriend.uid === friendUid) {
        closeChat();
        document.getElementById('infoPanel')?.classList.remove('open');
    }
    closeProfileModal();

    // Delete all messages between the two users
    try {
        const msgsSent = await getDocs(query(
            collection(db, 'messages'),
            where('senderUid', '==', currentUser.uid),
            where('receiverUid', '==', friendUid)
        ));
        const msgsReceived = await getDocs(query(
            collection(db, 'messages'),
            where('senderUid', '==', friendUid),
            where('receiverUid', '==', currentUser.uid)
        ));

        const allDocs = [];
        msgsSent.forEach(d => allDocs.push(d.ref));
        msgsReceived.forEach(d => allDocs.push(d.ref));

        // Batch delete in chunks of 500 (Firestore limit)
        for (let i = 0; i < allDocs.length; i += 500) {
            const batch = writeBatch(db);
            allDocs.slice(i, i + 500).forEach(ref => batch.delete(ref));
            await batch.commit();
        }
    } catch (e) {
        console.error('Error deleting messages:', e);
    }

    // Delete the friendship document
    await deleteDoc(doc(db, 'friend_requests', reqId));
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
    profileBio.value = profile.bio || '';

    // Hide email for other users — privacy
    const profileEmailBlock = document.getElementById('profileEmailBlock');
    if (isOwnProfile) {
        profileEmail.value = profile.email || auth.currentUser?.email || '';
        if (profileEmailBlock) profileEmailBlock.style.display = 'block';
    } else {
        if (profileEmailBlock) profileEmailBlock.style.display = 'none';
    }

    // Handle encrypted avatar
    if (profile.avatarStoragePath && profile.encKeyB64) {
        try {
            const blob = await downloadAndDecryptAvatar(profile.avatarStoragePath, profile.encKeyB64);
            const url = URL.createObjectURL(blob);
            profileAvatarImg.src = url;
            profileAvatarImg.style.display = 'block';
            profileAvatarLetter.style.display = 'none';
        } catch (e) {
            console.error('Failed to decrypt avatar:', e);
            profileAvatarImg.style.display = 'none';
            profileAvatarLetter.style.display = 'flex';
            applyAvatarToElement(profileAvatarLetter, profile);
        }
    } else if (profile.avatarUrl) {
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

/* === AVATAR CROP SYSTEM === */
const avatarCropModal = document.getElementById('avatarCropModal');
const avatarCropCanvas = document.getElementById('avatarCropCanvas');
const avatarCropArea = document.getElementById('avatarCropArea');
const avatarCropConfirmBtn = document.getElementById('avatarCropConfirmBtn');
const avatarCropCancelBtn = document.getElementById('avatarCropCancelBtn');

let cropState = {
    img: null,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    dragging: false,
    startX: 0,
    startY: 0,
    startOffsetX: 0,
    startOffsetY: 0,
    canvasSize: 280
};

function drawCropCanvas() {
    if (!cropState.img) return;
    const ctx = avatarCropCanvas.getContext('2d');
    const size = cropState.canvasSize;
    avatarCropCanvas.width = size;
    avatarCropCanvas.height = size;
    ctx.clearRect(0, 0, size, size);

    // Draw the image
    const img = cropState.img;
    const drawSize = Math.min(img.width, img.height) * cropState.scale;
    const drawW = drawSize;
    const drawH = drawSize;
    ctx.drawImage(img, cropState.offsetX, cropState.offsetY, drawW, drawH);

    // Telegram-style: dark overlay outside the circle
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.beginPath();
    ctx.rect(0, 0, size, size);
    // Counter-clockwise circle to cut out the center
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2, true);
    ctx.fill();
    ctx.restore();

    // Circle border
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
}

function initCropWithImage(file) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
        URL.revokeObjectURL(url);
        cropState.img = img;
        // Fit the image so the shorter side fills the canvas
        const minDim = Math.min(img.width, img.height);
        cropState.scale = cropState.canvasSize / minDim;
        // Center
        cropState.offsetX = (cropState.canvasSize - img.width * cropState.scale) / 2;
        cropState.offsetY = (cropState.canvasSize - img.height * cropState.scale) / 2;
        drawCropCanvas();
        avatarCropModal.classList.add('active');
    };
    img.src = url;
}

function getCroppedBlob() {
    return new Promise((resolve) => {
        const outSize = 512;
        const outCanvas = document.createElement('canvas');
        outCanvas.width = outSize;
        outCanvas.height = outSize;
        const ctx = outCanvas.getContext('2d');

        const img = cropState.img;
        const scale = cropState.scale;

        // Map the visible area (canvasSize x canvasSize) back to original image coordinates
        const srcX = -cropState.offsetX / scale;
        const srcY = -cropState.offsetY / scale;
        const srcW = cropState.canvasSize / scale;
        const srcH = cropState.canvasSize / scale;

        // Draw the visible area at full output resolution
        ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, outSize, outSize);

        // Apply circular clip for avatar
        ctx.globalCompositeOperation = 'destination-in';
        ctx.beginPath();
        ctx.arc(outSize / 2, outSize / 2, outSize / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';

        outCanvas.toBlob((blob) => {
            resolve(blob);
        }, 'image/png');
    });
}

// Mouse/touch events for panning the crop area
if (avatarCropArea) {
    avatarCropArea.addEventListener('mousedown', (e) => {
        e.preventDefault();
        cropState.dragging = true;
        cropState.startX = e.clientX;
        cropState.startY = e.clientY;
        cropState.startOffsetX = cropState.offsetX;
        cropState.startOffsetY = cropState.offsetY;
    });
    window.addEventListener('mousemove', (e) => {
        if (!cropState.dragging) return;
        cropState.offsetX = cropState.startOffsetX + (e.clientX - cropState.startX);
        cropState.offsetY = cropState.startOffsetY + (e.clientY - cropState.startY);
        drawCropCanvas();
    });
    window.addEventListener('mouseup', () => {
        cropState.dragging = false;
    });

    // Touch support
    avatarCropArea.addEventListener('touchstart', (e) => {
        e.preventDefault();
        const touch = e.touches[0];
        cropState.dragging = true;
        cropState.startX = touch.clientX;
        cropState.startY = touch.clientY;
        cropState.startOffsetX = cropState.offsetX;
        cropState.startOffsetY = cropState.offsetY;
    }, { passive: false });
    window.addEventListener('touchmove', (e) => {
        if (!cropState.dragging) return;
        const touch = e.touches[0];
        cropState.offsetX = cropState.startOffsetX + (touch.clientX - cropState.startX);
        cropState.offsetY = cropState.startOffsetY + (touch.clientY - cropState.startY);
        drawCropCanvas();
    });
    window.addEventListener('touchend', () => {
        cropState.dragging = false;
    });

    // Pinch-to-zoom
    let lastPinchDist = 0;
    avatarCropArea.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            lastPinchDist = Math.sqrt(dx * dx + dy * dy);
        }
    }, { passive: false });
    avatarCropArea.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2) {
            e.preventDefault();
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (lastPinchDist > 0) {
                const delta = dist / lastPinchDist;
                cropState.scale *= delta;
                drawCropCanvas();
            }
            lastPinchDist = dist;
        }
    }, { passive: false });

    // Scroll zoom
    avatarCropArea.addEventListener('wheel', (e) => {
        e.preventDefault();
        const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
        cropState.scale *= zoomFactor;
        drawCropCanvas();
    }, { passive: false });
}

avatarCropCancelBtn?.addEventListener('click', () => {
    avatarCropModal.classList.remove('active');
    cropState.img = null;
});

avatarCropConfirmBtn?.addEventListener('click', async () => {
    if (!cropState.img || !currentUser || profileModalUid !== currentUser.uid) return;
    avatarCropConfirmBtn.disabled = true;
    avatarCropConfirmBtn.textContent = 'Сохранение...';

    try {
        const blob = await getCroppedBlob();
        avatarCropModal.classList.remove('active');

        // Encrypt + upload to Supabase
        const { path: avatarStoragePath, encKeyB64 } = await uploadEncryptedAvatar(blob, currentUser.uid);

        // Update Firestore profile with storage path + key instead of public URL
        await updateDoc(doc(db, 'users', currentUser.uid), {
            avatarStoragePath,
            encKeyB64,
            avatarUrl: ''  // clear legacy URL
        });

        // Update local cache
        currentUser = { ...currentUser, avatarStoragePath, encKeyB64, avatarUrl: '' };
        userProfilesCache[currentUser.uid] = { ...currentUser };
        openProfile(currentUser.uid);
        showNotification('Аватар обновлён.', 'success');
    } catch (error) {
        console.error('Ошибка загрузки аватара:', error);
        showNotification('Не удалось загрузить аватар.', 'error');
    } finally {
        avatarCropConfirmBtn.disabled = false;
        avatarCropConfirmBtn.textContent = 'Сохранить';
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
    // Open crop modal instead of uploading directly
    initCropWithImage(file);
});

profileRemoveFriendBtn?.addEventListener('click', () => {
    if (!profileModalUid || profileModalUid === currentUser.uid) return;
    confirmRemoveFriend({ uid: profileModalUid, username: profileUsername.textContent });
});

/* === СИСТЕМА ЗВОНКОВ (WebRTC + Firestore Signaling) === */
const callModal = document.getElementById('callModal');
const callVoiceBtn = document.getElementById('callVoiceBtn');
const callVideoBtn = document.getElementById('callVideoBtn');
const callRejectBtn = document.getElementById('callRejectBtn');
const callAcceptBtn = document.getElementById('callAcceptBtn');
const callCancelBtn = document.getElementById('callCancelBtn');
const videoCallFS = document.getElementById('videoCallFS');
const videoCallEndBtn = document.getElementById('videoCallEndBtn');
const pipMiniCall = document.getElementById('pipMiniCall');
const pipMiniEnd = document.getElementById('pipMiniEnd');
const btnToggleMic = document.getElementById('btnToggleMic');
const btnToggleCamera = document.getElementById('btnToggleCamera');
const btnScreenShare = document.getElementById('btnScreenShare');

const ICE_SERVERS = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' }
    ]
};

let peerConnection = null;
let localStream = null;
let currentCallId = null;
let currentCallType = ''; // 'voice' | 'video'
let callDocRef = null;
let callUnsubscribe = null;
let callerCandidatesUnsub = null;
let receiverCandidatesUnsub = null;
let callTimerInterval = null;
let callStartTime = null;
let isInCall = false;
let isMicOn = true;
let isCameraOn = true;
let incomingCallUnsubscribe = null;
let isScreenSharing = false;
let screenStream = null;
let cameraTrack = null;
let callEventSaved = false;
let isCallInitiator = false;
let isPipSwapped = false;
let ringSoundInterval = null;

// === RING SOUND (Web Audio API) ===
let audioCtx = null;
function getAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
}

function playRingTone() {
    const ctx = getAudioCtx();
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();
    osc1.type = 'sine'; osc1.frequency.value = 440;
    osc2.type = 'sine'; osc2.frequency.value = 480;
    gain.gain.value = 0.15;
    osc1.connect(gain); osc2.connect(gain);
    gain.connect(ctx.destination);
    osc1.start(); osc2.start();
    // Ring pattern: 1s on, 2s off
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.setValueAtTime(0, ctx.currentTime + 1);
    return { osc1, osc2, gain, stopAt: ctx.currentTime + 1 };
}

function startRingSound() {
    stopRingSound();
    let currentRing = playRingTone();
    ringSoundInterval = setInterval(() => {
        if (currentRing) {
            try { currentRing.osc1.stop(); currentRing.osc2.stop(); } catch(e) {}
        }
        currentRing = playRingTone();
    }, 3000);
}

function stopRingSound() {
    if (ringSoundInterval) { clearInterval(ringSoundInterval); ringSoundInterval = null; }
}

callVoiceBtn.addEventListener('click', () => initiateCall('voice'));
callVideoBtn.addEventListener('click', () => initiateCall('video'));
callRejectBtn.addEventListener('click', rejectCall);
callAcceptBtn.addEventListener('click', acceptCall);
callCancelBtn.addEventListener('click', endCall);
videoCallEndBtn.addEventListener('click', endCall);
pipMiniEnd.addEventListener('click', endCall);
pipMiniCall.addEventListener('click', () => {
    // Bring back the call view
    pipMiniCall.style.display = 'none';
    if (currentCallType === 'video') {
        videoCallFS.classList.add('active');
    } else {
        callModal.classList.add('active');
    }
});

// PiP swap: tap on local video (PiP) to swap local/remote video positions (not audio)
document.querySelector('.vc-pip')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const pipContainer = document.querySelector('.vc-pip');
    const videoCallFS = document.getElementById('videoCallFS');
    const localVideo = document.getElementById('localVideo');
    const remoteVideo = document.getElementById('remoteVideo');
    if (!localVideo || !remoteVideo || !pipContainer) return;

    if (!isPipSwapped) {
        // Move remote video into PiP, local video to main view
        remoteVideo.style.width = '100%'; remoteVideo.style.height = '100%'; remoteVideo.style.borderRadius = '12px';
        localVideo.style.width = '100%'; localVideo.style.height = '100%'; localVideo.style.borderRadius = '';
        pipContainer.appendChild(remoteVideo);
        videoCallFS.insertBefore(localVideo, videoCallFS.firstChild);
    } else {
        // Restore: local in PiP, remote in main
        localVideo.style.width = '100%'; localVideo.style.height = '100%'; localVideo.style.borderRadius = '12px';
        remoteVideo.style.width = '100%'; remoteVideo.style.height = '100%'; remoteVideo.style.borderRadius = '';
        pipContainer.appendChild(localVideo);
        videoCallFS.insertBefore(remoteVideo, videoCallFS.firstChild);
    }
    isPipSwapped = !isPipSwapped;
});
btnToggleMic.addEventListener('click', toggleMic);
btnToggleCamera.addEventListener('click', toggleCamera);
btnScreenShare?.addEventListener('click', toggleScreenShare);

function toggleMic() {
    if (!localStream) return;
    const audioTracks = localStream.getAudioTracks();
    if (audioTracks.length === 0) return;
    isMicOn = !isMicOn;
    audioTracks.forEach(t => t.enabled = isMicOn);
    btnToggleMic.style.background = isMicOn ? 'rgba(255,255,255,0.2)' : 'var(--danger)';
    const iconUse = btnToggleMic.querySelector('use');
    if (iconUse) iconUse.setAttribute('href', isMicOn ? '#icon-mic' : '#icon-mic-off');
}

function toggleCamera() {
    if (!localStream || currentCallType !== 'video') return;
    const videoTracks = localStream.getVideoTracks();
    if (videoTracks.length === 0) return;
    isCameraOn = !isCameraOn;
    videoTracks.forEach(t => t.enabled = isCameraOn);
    btnToggleCamera.style.background = isCameraOn ? 'rgba(255,255,255,0.2)' : 'var(--danger)';
    const iconUse = btnToggleCamera.querySelector('use');
    if (iconUse) iconUse.setAttribute('href', isCameraOn ? '#icon-video' : '#icon-video-off');
}

function updateDeviceButtons() {
    if (!localStream) return;
    const hasAudio = localStream.getAudioTracks().length > 0;
    const hasVideo = localStream.getVideoTracks().length > 0;
    if (!hasAudio) {
        isMicOn = false;
        btnToggleMic.classList.add('disabled');
        btnToggleMic.style.background = 'rgba(255,255,255,0.1)';
        const iconUse = btnToggleMic.querySelector('use');
        if (iconUse) iconUse.setAttribute('href', '#icon-mic-off');
    } else {
        btnToggleMic.classList.remove('disabled');
    }
    if (!hasVideo) {
        isCameraOn = false;
        btnToggleCamera.classList.add('disabled');
        btnToggleCamera.style.background = 'rgba(255,255,255,0.1)';
        const iconUse = btnToggleCamera.querySelector('use');
        if (iconUse) iconUse.setAttribute('href', '#icon-video-off');
    } else {
        btnToggleCamera.classList.remove('disabled');
    }
    // Hide screen share button for voice calls
    if (currentCallType !== 'video' && btnScreenShare) {
        btnScreenShare.style.display = 'none';
    } else if (btnScreenShare) {
        btnScreenShare.style.display = '';
    }
}

async function toggleScreenShare() {
    if (!peerConnection || !localStream) return;
    if (isScreenSharing) {
        // Stop screen share, revert to camera
        if (screenStream) {
            screenStream.getTracks().forEach(t => t.stop());
            screenStream = null;
        }
        if (cameraTrack) {
            const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) await sender.replaceTrack(cameraTrack);
            // Restore: local camera in PiP, remote in main
            const localVideo = document.getElementById('localVideo');
            const remoteVideo = document.getElementById('remoteVideo');
            if (localVideo) localVideo.srcObject = localStream;
            if (isPipSwapped) {
                // If PiP was swapped, unswap
                const tmp = localVideo.srcObject;
                localVideo.srcObject = remoteVideo.srcObject;
                remoteVideo.srcObject = tmp;
                isPipSwapped = false;
            }
        }
        isScreenSharing = false;
        btnScreenShare.style.background = 'rgba(255,255,255,0.2)';
    } else {
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
            const screenTrack = screenStream.getVideoTracks()[0];
            const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) {
                cameraTrack = sender.track;
                await sender.replaceTrack(screenTrack);
            }
            // Show screen share in LOCAL preview (so user sees what they're sharing)
            const localVideo = document.getElementById('localVideo');
            if (localVideo) localVideo.srcObject = screenStream;
            isScreenSharing = true;
            btnScreenShare.style.background = 'var(--primary)';
            screenTrack.onended = () => {
                if (isScreenSharing) toggleScreenShare();
            };
        } catch (e) {
            console.error('Screen share error:', e);
            showNotification('Не удалось начать демонстрацию экрана.', 'error');
        }
    }
}

async function saveCallEvent(status, duration) {
    if (!currentUser || !currentChatFriend || callEventSaved) return;
    // Only the caller (initiator) saves the call event to avoid duplication
    if (!isCallInitiator) return;
    callEventSaved = true;
    try {
        const durationStr = duration > 0 ? formatCallDuration(duration) : '';
        await addDoc(collection(db, 'messages'), {
            senderUid: currentUser.uid,
            receiverUid: currentChatFriend.uid,
            type: 'call',
            callType: currentCallType || 'voice',
            callStatus: status,
            callDuration: durationStr,
            text: '',
            createdAt: Date.now(),
            isRead: true
        });
    } catch (e) {
        // Silently fail — permission error means Firestore rules haven't been deployed yet
        console.warn('Call event save failed (deploy Firestore rules?):', e.message);
    }
}

function formatCallDuration(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}

function startCallTimer() {
    callStartTime = Date.now();
    const formatTime = (ms) => {
        const s = Math.floor(ms / 1000);
        const m = Math.floor(s / 60);
        const sec = s % 60;
        return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    };
    callTimerInterval = setInterval(() => {
        const elapsed = Date.now() - callStartTime;
        const timeStr = formatTime(elapsed);
        const callTimerEl = document.getElementById('callTimer');
        if (callTimerEl) { callTimerEl.textContent = timeStr; callTimerEl.style.display = 'block'; }
        const vcTimerEl = document.getElementById('vcCallTimer');
        if (vcTimerEl) { vcTimerEl.textContent = timeStr; vcTimerEl.style.display = 'block'; }
        const pipTimerEl = document.getElementById('pipMiniTimer');
        if (pipTimerEl) pipTimerEl.textContent = timeStr;
    }, 1000);
}

function stopCallTimer() {
    if (callTimerInterval) { clearInterval(callTimerInterval); callTimerInterval = null; }
}

async function initiateCall(type) {
    if (!currentChatFriend || isInCall) return;
    currentCallType = type;
    isInCall = true;
    callEventSaved = false;
    isCallInitiator = true;

    // Get media stream with camera fallback
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: type === 'video'
        });
    } catch (e) {
        console.warn('Full media failed, trying audio-only:', e);
        if (type === 'video') {
            try {
                localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                showNotification('Камера недоступна. Видеозвонок без камеры.', 'info');
            } catch (e2) {
                console.error('Audio access error:', e2);
                showNotification('Не удалось получить доступ к микрофону.', 'error');
                isInCall = false;
                return;
            }
        } else {
            showNotification('Не удалось получить доступ к микрофону.', 'error');
            isInCall = false;
            return;
        }
    }

    isMicOn = localStream.getAudioTracks().length > 0;
    isCameraOn = localStream.getVideoTracks().length > 0;

    // Create peer connection
    createPeerConnection();
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
    updateDeviceButtons();
    try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
    } catch (e) {
        console.error('Offer error:', e);
        cleanupCall();
        return;
    }

    // Create Firestore call document
    callDocRef = doc(db, 'calls', `${currentUser.uid}_${currentChatFriend.uid}_${Date.now()}`);
    currentCallId = callDocRef.id;
    await setDoc(callDocRef, {
        callerUid: currentUser.uid,
        callerUsername: currentUser.username,
        receiverUid: currentChatFriend.uid,
        type,
        status: 'ringing',
        offer: JSON.stringify(peerConnection.localDescription),
        createdAt: Date.now()
    });

    // Show outgoing call UI
    document.getElementById('callTypeText').textContent = type === 'video' ? 'Исходящий видеозвонок' : 'Исходящий аудиозвонок';
    document.getElementById('callName').textContent = currentChatFriend.username;
    document.getElementById('callStatus').textContent = 'Вызов...';
    document.getElementById('callTimer').style.display = 'none';
    const av = document.getElementById('callAvatar');
    av.innerHTML = ''; av.textContent = currentChatFriend.username.charAt(0).toUpperCase(); av.style.background = getUserColor(currentChatFriend.uid);
    document.getElementById('outgoingControls').style.display = 'flex';
    document.getElementById('incomingControls').style.display = 'none';
    callModal.classList.add('active');
    startRingSound();

    // Listen for answer
    callUnsubscribe = onSnapshot(callDocRef, async (snap) => {
        const data = snap.data();
        if (!data) return;

        if (data.status === 'accepted' && data.answer && peerConnection && peerConnection.signalingState === 'have-local-offer') {
            try {
                const answer = JSON.parse(data.answer);
                await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
            } catch (e) {
                console.error('Set remote desc error:', e);
            }
        } else if (data.status === 'rejected') {
            stopRingSound();
            showNotification('Звонок отклонён.', 'info');
            try { await saveCallEvent('rejected', 0); } catch(e) { console.warn('Save call event error:', e); }
            cleanupCall();
        } else if (data.status === 'ended') {
            const dur = callStartTime ? (Date.now() - callStartTime) : 0;
            try { await saveCallEvent(dur > 0 ? 'answered' : 'missed', dur); } catch(e) { console.warn('Save call event error:', e); }
            cleanupCall();
        }
    }, (err) => console.warn('Call listener error:', err));

    // Send caller ICE candidates
    peerConnection.onicecandidate = async (event) => {
        if (event.candidate && currentCallId) {
            try {
                await addDoc(collection(db, 'calls', currentCallId, 'callerCandidates'), event.candidate.toJSON());
            } catch (e) { console.warn('ICE candidate send error:', e); }
        }
    };

    // Listen for receiver ICE candidates
    listenForRemoteCandidates('receiverCandidates');

    // Send push notification about the call
    await sendPushToUser(currentChatFriend.uid, `${type === 'video' ? 'Видеозвонок' : 'Аудиозвонок'} от ${currentUser.username}`, currentUser.uid);
}

function createPeerConnection() {
    peerConnection = new RTCPeerConnection(ICE_SERVERS);

    peerConnection.onconnectionstatechange = () => {
        const state = peerConnection.connectionState;
        if (state === 'connected') {
            // Call connected! Switch to active call UI
            stopRingSound();
            document.getElementById('callStatus').textContent = 'Подключено';
            startCallTimer();
            // For outgoing calls, transition to proper UI
            if (currentCallType === 'video') {
                callModal.classList.remove('active');
                const localVideo = document.getElementById('localVideo');
                const hasLocalVideo = localStream && localStream.getVideoTracks().length > 0;
                if (localVideo && localStream) localVideo.srcObject = localStream;
                // Hide PiP if no local camera
                const pipEl = document.querySelector('.vc-pip');
                if (pipEl) pipEl.style.display = hasLocalVideo ? '' : 'none';
                document.getElementById('vcCallName').textContent = currentChatFriend ? currentChatFriend.username : '';
                document.getElementById('vcCallStatus').textContent = 'Подключено';
                videoCallFS.classList.add('active');
            } else {
                // Voice call — show timer
                document.getElementById('callTypeText').textContent = 'Аудиозвонок';
                document.getElementById('callStatus').textContent = 'Разговор';
                document.getElementById('outgoingControls').style.display = 'flex';
                document.getElementById('incomingControls').style.display = 'none';
            }
        } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
            cleanupCall();
        }
    };

    peerConnection.ontrack = (event) => {
        const remoteStream = event.streams[0];
        const remoteVideo = document.getElementById('remoteVideo');
        if (remoteVideo) remoteVideo.srcObject = remoteStream;
    };
}

async function acceptCall() {
    if (!currentCallId || !callDocRef) return;
    stopRingSound();

    // Get media stream with camera fallback
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: currentCallType === 'video'
        });
    } catch (e) {
        console.warn('Full media failed, trying audio-only:', e);
        if (currentCallType === 'video') {
            try {
                localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                showNotification('Камера недоступна. Видеозвонок без камеры.', 'info');
            } catch (e2) {
                console.error('Audio access error:', e2);
                showNotification('Не удалось получить доступ к микрофону.', 'error');
                return;
            }
        } else {
            showNotification('Не удалось получить доступ к микрофону.', 'error');
            return;
        }
    }

    isMicOn = localStream.getAudioTracks().length > 0;
    isCameraOn = localStream.getVideoTracks().length > 0;
    isInCall = true;
    callEventSaved = false;
    isCallInitiator = false;

    // Create peer connection
    createPeerConnection();
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
    updateDeviceButtons();

    // Set remote description (the offer)
    const callSnap = await getDoc(callDocRef);
    const callData = callSnap.data();
    const offer = JSON.parse(callData.offer);
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

    // Create answer
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    // Update Firestore
    await updateDoc(callDocRef, {
        status: 'accepted',
        answer: JSON.stringify(peerConnection.localDescription)
    });

    // Hide call modal, show active call UI
    callModal.classList.remove('active');
    if (currentCallType === 'video') {
        const localVideo = document.getElementById('localVideo');
        const hasLocalVideo = localStream && localStream.getVideoTracks().length > 0;
        if (localVideo) localVideo.srcObject = localStream;
        const pipEl = document.querySelector('.vc-pip');
        if (pipEl) pipEl.style.display = hasLocalVideo ? '' : 'none';
        document.getElementById('vcCallName').textContent = callData.callerUsername;
        document.getElementById('vcCallStatus').textContent = 'Подключение...';
        videoCallFS.classList.add('active');
    } else {
        // Voice call — show in call modal with timer
        document.getElementById('callTypeText').textContent = 'Аудиозвонок';
        document.getElementById('callStatus').textContent = 'Подключение...';
        document.getElementById('callTimer').style.display = 'none';
        document.getElementById('outgoingControls').style.display = 'flex';
        document.getElementById('incomingControls').style.display = 'none';
        // Update cancel btn to become end call
        const cancelBtn = document.getElementById('callCancelBtn');
        if (cancelBtn) cancelBtn.title = 'Завершить';
        callModal.classList.add('active');
    }

    // Send receiver ICE candidates
    peerConnection.onicecandidate = async (event) => {
        if (event.candidate && currentCallId) {
            try {
                await addDoc(collection(db, 'calls', currentCallId, 'receiverCandidates'), event.candidate.toJSON());
            } catch (e) { console.warn('ICE candidate send error:', e); }
        }
    };

    // Listen for caller ICE candidates
    listenForRemoteCandidates('callerCandidates');

    // Listen for call status changes (end call)
    callUnsubscribe = onSnapshot(callDocRef, (snap) => {
        const data = snap.data();
        if (!data) return;
        if (data.status === 'ended') {
            cleanupCall();
        }
    }, (err) => console.warn('Call listener error:', err));
}

function listenForRemoteCandidates(collectionName) {
    if (!currentCallId) return;
    const unsub = onSnapshot(
        collection(db, 'calls', currentCallId, collectionName),
        (snapshot) => {
            snapshot.docChanges().forEach((change) => {
                if (change.type === 'added' && peerConnection && peerConnection.remoteDescription) {
                    try {
                        peerConnection.addIceCandidate(new RTCIceCandidate(change.doc.data()));
                    } catch (e) { /* ignore */ }
                }
            });
        },
        (err) => console.warn('Candidate listener error:', err)
    );
    if (collectionName === 'callerCandidates') {
        callerCandidatesUnsub = unsub;
    } else {
        receiverCandidatesUnsub = unsub;
    }
}

async function rejectCall() {
    stopRingSound();
    if (callDocRef) {
        try { await updateDoc(callDocRef, { status: 'rejected' }); } catch (e) {}
    }
    saveCallEvent('rejected', 0);
    callModal.classList.remove('active');
    cleanupCallResources();
}

async function endCall() {
    const dur = callStartTime ? (Date.now() - callStartTime) : 0;
    const status = dur > 0 ? 'answered' : 'missed';
    if (callDocRef) {
        try { await updateDoc(callDocRef, { status: 'ended' }); } catch (e) {}
    }
    saveCallEvent(status, dur);
    cleanupCall();
}

function cleanupCall() {
    callModal.classList.remove('active');
    videoCallFS.classList.remove('active');
    pipMiniCall.style.display = 'none';
    stopCallTimer();
    stopRingSound();
    // Reset timer display
    const callTimerEl = document.getElementById('callTimer');
    if (callTimerEl) { callTimerEl.textContent = '00:00'; callTimerEl.style.display = 'none'; }
    const vcTimerEl = document.getElementById('vcCallTimer');
    if (vcTimerEl) { vcTimerEl.textContent = '00:00'; vcTimerEl.style.display = 'none'; }
    const pipTimerEl = document.getElementById('pipMiniTimer');
    if (pipTimerEl) pipTimerEl.textContent = '';
    callStartTime = null;
    isInCall = false;
    currentCallId = null;
    currentCallType = '';
    callDocRef = null;
    isCallInitiator = false;
    isPipSwapped = false;
    // Clean up screen share
    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
        screenStream = null;
    }
    isScreenSharing = false;
    cameraTrack = null;
    // Restore PiP visibility for next call
    const pipEl = document.querySelector('.vc-pip');
    if (pipEl) pipEl.style.display = '';
    cleanupCallResources();
}

function cleanupCallResources() {
    if (callUnsubscribe) { callUnsubscribe(); callUnsubscribe = null; }
    if (callerCandidatesUnsub) { callerCandidatesUnsub(); callerCandidatesUnsub = null; }
    if (receiverCandidatesUnsub) { receiverCandidatesUnsub(); receiverCandidatesUnsub = null; }
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
    }
    const remoteVideo = document.getElementById('remoteVideo');
    if (remoteVideo) remoteVideo.srcObject = null;
    const localVideo = document.getElementById('localVideo');
    if (localVideo) localVideo.srcObject = null;
    // Reset button styles
    if (btnToggleMic) { btnToggleMic.style.background = 'rgba(255,255,255,0.2)'; btnToggleMic.classList.remove('disabled'); const u = btnToggleMic.querySelector('use'); if (u) u.setAttribute('href', '#icon-mic'); }
    if (btnToggleCamera) { btnToggleCamera.style.background = 'rgba(255,255,255,0.2)'; btnToggleCamera.classList.remove('disabled'); const u = btnToggleCamera.querySelector('use'); if (u) u.setAttribute('href', '#icon-video'); }
    if (btnScreenShare) { btnScreenShare.style.background = 'rgba(255,255,255,0.2)'; btnScreenShare.style.display = ''; }
}

// Listen for incoming calls
function startIncomingCallListener() {
    if (!currentUser) return;
    if (incomingCallUnsubscribe) incomingCallUnsubscribe();

    const callsQuery = query(
        collection(db, 'calls'),
        where('receiverUid', '==', currentUser.uid),
        where('status', '==', 'ringing')
    );

    incomingCallUnsubscribe = onSnapshot(callsQuery, (snapshot) => {
        snapshot.docChanges().forEach((change) => {
            if (change.type === 'added' && !isInCall) {
                const callData = change.doc.data();
                currentCallId = change.doc.id;
                callDocRef = doc(db, 'calls', currentCallId);
                currentCallType = callData.type;

                // Show incoming call UI
                document.getElementById('callTypeText').textContent = callData.type === 'video' ? 'Входящий видеозвонок' : 'Входящий аудиозвонок';
                document.getElementById('callName').textContent = callData.callerUsername;
                document.getElementById('callStatus').textContent = 'Звонит...';
                document.getElementById('callTimer').style.display = 'none';
                const av = document.getElementById('callAvatar');
                av.innerHTML = ''; av.textContent = callData.callerUsername.charAt(0).toUpperCase(); av.style.background = getUserColor(callData.callerUid);
                document.getElementById('outgoingControls').style.display = 'none';
                document.getElementById('incomingControls').style.display = 'flex';
                callModal.classList.add('active');
            }
        });
    }, (err) => console.warn('Incoming call listener error:', err));
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

    // Локальные уведомления для desktop (fallback если серверный push не доходит)
    const unreadQuery = query(
        collection(db, 'messages'),
        where('receiverUid', '==', currentUser.uid),
        where('isRead', '==', false)
    );
    onSnapshot(unreadQuery, (snapshot) => {
        snapshot.docChanges().forEach((change) => {
            if (change.type === 'added') {
                const msg = change.doc.data();
                const senderUid = msg.senderUid;
                // Only show local notification if we're NOT in the active chat with this sender
                const isActive = currentChatFriend && currentChatFriend.uid === senderUid && document.visibilityState === 'visible';
                if (!isActive && Notification.permission === 'granted') {
                    // Use service worker for consistent notification handling
                    if ('serviceWorker' in navigator) {
                        navigator.serviceWorker.ready.then(reg => {
                            reg.showNotification(msg.senderUsername || 'Новое сообщение', {
                                body: msg.type === 'image' ? '\u{1F4F7} Фото' : msg.text || '',
                                icon: 'https://cdn-icons-png.flaticon.com/512/1041/1041916.png',
                                tag: senderUid || 'general',
                                renotify: true,
                                data: { senderUid }
                            });
                        });
                    }
                }
            }
        });
    }, (err) => console.warn('Unread messages listener error:', err));
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
                avatarStoragePath: data.avatarStoragePath || '',
                encKeyB64: data.encKeyB64 || '',
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