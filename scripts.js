// scripts.js
import { auth, db } from './firebase.js';
import { 
    signInWithEmailAndPassword, 
    createUserWithEmailAndPassword, 
    onAuthStateChanged, 
    signOut 
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
    updateDoc,
    deleteDoc,
    limit,
    orderBy
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

/* === ЛОКАЛЬНОЕ СОСТОЯНИЕ === */
let currentUser = null; // { uid, username }
let currentChatFriend = null; // { uid, username, color }
let activeTab = 'login'; // 'login' | 'register'
let unsubscribeMessages = null;
let unsubscribeFriends = null;
let unsubscribeRequests = null;
let userColorsCache = {};

// Предопределенные цвета аватаров
const avatarsBg = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#0ea5e9", "#6366f1", "#a855f7", "#ec4899"];

const LOGIN_REGEX = /^[a-z0-9]{3,20}$/;

function normalizeLoginInput(value) {
    return value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
}

function isValidLogin(login) {
    return LOGIN_REGEX.test(login);
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

function showCustomConfirm(title, text, onConfirm) {
    if (!customConfirmModal) {
        if (onConfirm) onConfirm();
        return;
    }
    customConfirmTitle.textContent = title;
    customConfirmText.textContent = text;
    confirmCallback = onConfirm;
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

const usernameModal = document.getElementById('usernameModal');
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

// Слушатель состояния авторизации
onAuthStateChanged(auth, async (firebaseUser) => {
    if (firebaseUser) {
        try {
            const userSnap = await getDoc(doc(db, 'users', firebaseUser.uid));
            
            if (userSnap.exists()) {
                // Пользователь существует и у него есть никнейм
                currentUser = userSnap.data();
                myProfileName.textContent = currentUser.username;
                
                authContainer.classList.add('hidden');
                appContainer.classList.add('active');
                usernameModal.classList.remove('active');

                closeChat();
                startListeningRequestsAndFriends();
            } else {
                // Пользователь только что зарегистрировался, у него нет никнейма в базе
                mainAuthCard.style.display = 'none'; // Прячем форму входа
                usernameModal.classList.add('active'); // Показываем модалку выбора логина
            }
        } catch (err) {
            console.error("Ошибка проверки профиля:", err);
            showNotification('Ошибка связи с базой данных.', 'error');
        }
    } else {
        // Выход из аккаунта или не авторизован
        currentUser = null;
        stopAllSubscriptions();
        
        authContainer.classList.remove('hidden');
        mainAuthCard.style.display = 'block'; // Возвращаем форму входа
        appContainer.classList.remove('active');
        usernameModal.classList.remove('active');
        
        authEmailInput.value = '';
        authPasswordInput.value = '';
        setupUsernameInput.value = '';
        
        document.getElementById('searchResults').innerHTML = '';
        document.getElementById('friendRequestsList').innerHTML = '';
        document.getElementById('chatList').innerHTML = '';
        closeChat();

        authSubmitBtn.disabled = false;
        authSubmitBtn.textContent = activeTab === 'login' ? 'Войти' : 'Зарегистрироваться';
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
            createdAt: Date.now()
        });

        await setDoc(userRef, { uid: firebaseUser.uid });

        // 3. Данные успешно записаны, обновляем UI
        currentUser = { uid: firebaseUser.uid, username: rawLogin };
        myProfileName.textContent = currentUser.username;
        
        usernameModal.classList.remove('active');
        authContainer.classList.add('hidden');
        appContainer.classList.add('active');
        
        startListeningRequestsAndFriends();

    } catch (error) {
        console.error('Ошибка сохранения логина:', error);
        showNotification(error.message.includes('занят') ? error.message : 'Ошибка при сохранении логина.', 'error');
    } finally {
        setupUsernameBtn.disabled = false;
        setupUsernameBtn.textContent = 'Сохранить и войти';
    }
});

// Кнопка выхода
logoutBtn.addEventListener('click', () => {
    showCustomConfirm('Выход', 'Вы уверены, что хотите выйти?', () => signOut(auth));
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
        <span>@${user.username}</span>
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
                    <span>@${req.senderUsername}</span>
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
    chatList.innerHTML = '';
    if (friends.length === 0) {
        chatList.innerHTML = '<div style="color:var(--text-muted); font-size:13px; text-align:center; padding:20px;">У вас пока нет друзей. Найдите их по логину выше!</div>';
        return;
    }

    friends.forEach(friend => {
        const color = getUserColor(friend.uid);
        const avatarStr = friend.username.charAt(0).toUpperCase();

        const div = document.createElement('div');
        div.className = `chat-item ${currentChatFriend && currentChatFriend.uid === friend.uid ? 'active' : ''}`;
        div.onclick = () => selectFriendChat(friend);
        div.innerHTML = `
            <div class="avatar-container">
                <div class="avatar" style="background:${color}">${avatarStr}</div>
                <div class="online-dot active"></div>
            </div>
            <div class="chat-info">
                <div class="chat-row-1">
                    <div class="chat-name">${friend.username}</div>
                    <div class="chat-time"></div>
                </div>
                <div class="chat-row-2">
                    <div class="chat-last-msg" id="last-msg-${friend.uid}">Нажмите для общения</div>
                </div>
            </div>
        `;
        chatList.appendChild(div);

        // Получаем последнее сообщение для этого друга
        listenLastMessage(friend.uid);
    });
}

function listenLastMessage(friendUid) {
    // В реальном чате можно сделать быстрый запрос на последнее сообщение
    // Для экономии ресурсов и простоты мы оставим стандартную заглушку или обновим ее при получении сообщений
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

function closeChat() {
    currentChatFriend = null;
    noChatSelectedScreen.style.display = 'flex';
    chatHeader.style.display = 'none';
    messagesArea.style.display = 'none';
    chatInputArea.style.display = 'none';
    if (unsubscribeMessages) unsubscribeMessages();
}

function selectFriendChat(friend) {
    currentChatFriend = friend;

    // Скрываем заглушку и показываем чат
    noChatSelectedScreen.style.display = 'none';
    chatHeader.style.display = 'flex';
    messagesArea.style.display = 'flex';
    chatInputArea.style.display = 'flex';

    // Заполняем шапку чата
    activeName.textContent = `@${friend.username}`;
    activeAvatar.textContent = friend.username.charAt(0).toUpperCase();
    activeAvatar.style.background = getUserColor(friend.uid);
    activeStatus.textContent = 'в сети';

    // Обновляем активный класс в списке друзей
    document.querySelectorAll('.chat-item').forEach(el => el.classList.remove('active'));
    
    // Подписываемся на сообщения
    listenToMessages();

    // Мобильный вид - скрываем сайдбар
    if (window.innerWidth <= 768) {
        document.getElementById('sidebar').classList.add('hidden-mobile');
    }
}

// Слушатель инпута ввода
messageInput.addEventListener('input', () => {
    autoExpand(messageInput);
    micBtn.style.display = messageInput.value.trim() ? 'none' : 'flex';
    sendBtn.style.display = messageInput.value.trim() ? 'flex' : 'none';
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
    if (!text || !currentChatFriend) return;

    try {
        await addDoc(collection(db, 'messages'), {
            senderUid: currentUser.uid,
            receiverUid: currentChatFriend.uid,
            text: text,
            createdAt: Date.now()
        });

        messageInput.value = '';
        messageInput.style.height = 'inherit';
        micBtn.style.display = 'flex';
        sendBtn.style.display = 'none';
    } catch (e) {
        console.error("Ошибка отправки сообщения:", e);
        showNotification('Не удалось отправить сообщение.', 'error');
    }
}

function listenToMessages() {
    if (unsubscribeMessages) unsubscribeMessages();

    const mergedMessages = new Map();

    function renderMessages() {
        messagesArea.innerHTML = '';
        let lastDateString = '';

        const sorted = Array.from(mergedMessages.values()).sort((a, b) => a.createdAt - b.createdAt);

        sorted.forEach((msg) => {
            const isMyMessage = msg.senderUid === currentUser.uid;
            const date = new Date(msg.createdAt);
            const dateString = date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

            if (dateString !== lastDateString) {
                const divider = document.createElement('div');
                divider.className = 'date-divider';
                divider.innerHTML = `<span>${dateString}</span>`;
                messagesArea.appendChild(divider);
                lastDateString = dateString;
            }

            const timeString = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
            appendMessageNode(msg.text, isMyMessage, timeString);
        });

        const typingIndicator = document.getElementById('typingIndicator');
        messagesArea.appendChild(typingIndicator);
        scrollToBottom();
    }

    function applySnapshot(snapshot) {
        snapshot.docChanges().forEach((change) => {
            if (change.type === 'removed') {
                mergedMessages.delete(change.doc.id);
            } else {
                mergedMessages.set(change.doc.id, change.doc.data());
            }
        });
        renderMessages();
    }

    const sentQuery = query(
        collection(db, 'messages'),
        where('senderUid', '==', currentUser.uid),
        where('receiverUid', '==', currentChatFriend.uid),
        orderBy('createdAt', 'asc')
    );
    const receivedQuery = query(
        collection(db, 'messages'),
        where('senderUid', '==', currentChatFriend.uid),
        where('receiverUid', '==', currentUser.uid),
        orderBy('createdAt', 'asc')
    );

    const unsubSent = onSnapshot(sentQuery, applySnapshot, (err) => {
        console.error('Ошибка загрузки сообщений:', err);
        showNotification('Не удалось загрузить сообщения.', 'error');
    });
    const unsubReceived = onSnapshot(receivedQuery, applySnapshot, (err) => {
        console.error('Ошибка загрузки сообщений:', err);
        showNotification('Не удалось загрузить сообщения.', 'error');
    });

    unsubscribeMessages = () => {
        unsubSent();
        unsubReceived();
    };
}

function appendMessageNode(text, isOut, time) {
    const div = document.createElement('div');
    div.className = `message ${isOut ? 'msg-out' : 'msg-in'}`;
    
    div.innerHTML = `
        <div class="msg-bubble">
            ${text}
            <div class="msg-meta">
                <span>${time}</span>
                ${isOut ? `<span class="msg-status"><svg><use href="#icon-check-double"></use></svg></span>` : ''}
            </div>
        </div>
    `;
    const typingIndicator = document.getElementById('typingIndicator');
    messagesArea.insertBefore(div, typingIndicator);
}

function scrollToBottom() {
    messagesArea.scrollTop = messagesArea.scrollHeight;
}

/* === UI ПЕРЕКЛЮЧАТЕЛИ И ЗВОНКИ === */
const themeToggleBtn = document.getElementById('themeToggleBtn');
const themeToggleBtn2 = document.getElementById('themeToggleBtn2');
const backBtnMobile = document.getElementById('backBtnMobile');

themeToggleBtn.addEventListener('click', toggleTheme);
themeToggleBtn2.addEventListener('click', toggleTheme);

function toggleTheme() {
    const html = document.documentElement;
    if(html.getAttribute('data-theme') === 'dark') {
        html.setAttribute('data-theme', 'light');
    } else {
        html.setAttribute('data-theme', 'dark');
    }
}

backBtnMobile.addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('hidden-mobile');
});

// Кнопка информации о чате
const infoToggleBtn = document.getElementById('infoToggleBtn');
infoToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const panel = document.getElementById('infoPanel');
    
    // Обновляем панель информации
    if (currentChatFriend) {
        document.getElementById('infoName').textContent = `@${currentChatFriend.username}`;
        document.getElementById('infoAvatar').textContent = currentChatFriend.username.charAt(0).toUpperCase();
        document.getElementById('infoAvatar').style.background = getUserColor(currentChatFriend.uid);
        document.getElementById('infoStatus').textContent = 'В сети';
    }
    
    panel.classList.toggle('open');
});

/* === СИСТЕМА ЗВОНКОВ (КРАСИВАЯ АНИМАЦИЯ ДЛЯ ТЕСТА) === */
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
    document.getElementById('callName').textContent = `@${currentChatFriend.username}`;
    document.getElementById('callStatus').textContent = 'Гудки...';
    
    const av = document.getElementById('callAvatar');
    av.textContent = currentChatFriend.username.charAt(0).toUpperCase();
    av.style.background = getUserColor(currentChatFriend.uid);
    
    callModal.classList.add('active');

    // Симуляция ответа друга
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
