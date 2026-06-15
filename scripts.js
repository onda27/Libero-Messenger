/* === ДАННЫЕ И ГЕНЕРАЦИЯ === */
const firstNames = ["Алексей", "Мария", "Дмитрий", "Елена", "Максим", "Анна", "Иван", "Дарья", "Сергей", "Ольга"];
const avatarsBg = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#0ea5e9", "#6366f1", "#a855f7", "#ec4899"];

// Специальные чаты для демонстрации
const specialChats = [
    { id: 'c1', name: 'Катя 💜', avatarStr: 'К', color: '#a855f7', lastMsg: 'Зайду в плейс через 10 мин 🥰', time: '14:20', unread: 2, online: true, pinned: true },
    { id: 'c2', name: 'Бизнес Ассистент [BOT]', avatarStr: 'БА', color: '#3b82f6', lastMsg: 'Новая заявка на обработку: #1042', time: '13:05', unread: 0, online: true, pinned: true },
    { id: 'c3', name: 'Low Poly Gang', avatarStr: 'LP', color: '#10b981', lastMsg: 'Кто-то запекал нормали сегодня?', time: 'Вчера', unread: 5, online: false, pinned: false },
    { id: 'c4', name: 'Dev Squad', avatarStr: 'DS', color: '#f59e0b', lastMsg: 'Скинул коммит на GitHub Pages', time: 'Вчера', unread: 0, online: true, pinned: false },
];

let chats = [...specialChats];

// Генерация остальных чатов до 30
for(let i=5; i<=30; i++) {
    const name = firstNames[Math.floor(Math.random() * firstNames.length)] + " " + String.fromCharCode(65 + Math.floor(Math.random() * 26));
    chats.push({
        id: 'c'+i,
        name: name,
        avatarStr: name.charAt(0),
        color: avatarsBg[Math.floor(Math.random() * avatarsBg.length)],
        lastMsg: ['Ок', 'Спасибо!', 'Глянь файл', 'Завтра обсудим', '👍', 'Где ты?'][Math.floor(Math.random() * 6)],
        time: 'Пн',
        unread: Math.random() > 0.8 ? Math.floor(Math.random() * 10) + 1 : 0,
        online: Math.random() > 0.6,
        pinned: false
    });
}

let currentChatId = 'c1';

// Пул реалистичных сообщений для генерации 200 сообщений истории (фокус на Катю/разработку)
const msgPool = [
    "Привет!", "Как дела с дипломом?", "Я доделал авторизацию через Firebase.", 
    "Смотри, скрипт на Luau работает отлично, NPC не застревают.", 
    "Красиво получилось!", "Да, эффект стекла топ.", "На ПК не видно что чел с телефона печатает, а если с телефона смотреть то видно... надо фиксить 😅", 
    "Скинул референсы для блендера.", "Погнали в КС?", "Ага", "Понял", "Запускаю..."
];

const generatedHistory = [];
let dateMock = new Date();
dateMock.setDate(dateMock.getDate() - 5);

for(let i=0; i<200; i++) {
    if(i%40 === 0) {
        dateMock.setDate(dateMock.getDate() + 1);
        generatedHistory.push({ type: 'date', text: dateMock.toLocaleDateString('ru-RU', {day: 'numeric', month: 'long'}) });
    }
    const isOut = Math.random() > 0.5;
    let text = msgPool[Math.floor(Math.random() * msgPool.length)];
    if(i === 198) text = "Я делаю модельку персонажа для нашей игры)";
    if(i === 199) text = "Зайду в плейс через 10 мин 🥰"; // Последнее сообщение Кати
    
    generatedHistory.push({
        type: 'msg',
        text: text,
        out: isOut,
        time: '14:' + (i%60 < 10 ? '0'+(i%60) : i%60),
        read: true
    });
}

/* === ИНИЦИАЛИЗАЦИЯ И РЕНДЕР === */
function init() {
    renderChats();
    selectChat('c1');
    
    // Поиск
    document.getElementById('searchInput').addEventListener('input', (e) => {
        const val = e.target.value.toLowerCase();
        document.querySelectorAll('.chat-item').forEach(el => {
            const name = el.querySelector('.chat-name').textContent.toLowerCase();
            el.style.display = name.includes(val) ? 'flex' : 'none';
        });
    });
    
    // Инпут
    const msgInp = document.getElementById('messageInput');
    msgInp.addEventListener('input', () => {
        document.getElementById('micBtn').style.display = msgInp.value.trim() ? 'none' : 'flex';
        document.getElementById('sendBtn').style.display = msgInp.value.trim() ? 'flex' : 'none';
    });
}

function renderChats() {
    const list = document.getElementById('chatList');
    list.innerHTML = '';
    chats.forEach(chat => {
        const div = document.createElement('div');
        div.className = `chat-item ${chat.id === currentChatId ? 'active' : ''}`;
        div.onclick = () => selectChat(chat.id);
        div.innerHTML = `
            <div class="avatar-container">
                <div class="avatar" style="background:${chat.color}">${chat.avatarStr}</div>
                <div class="online-dot ${chat.online ? 'active' : ''}"></div>
            </div>
            <div class="chat-info">
                <div class="chat-row-1">
                    <div class="chat-name">${chat.name} ${chat.pinned ? '<svg class="pinned-icon"><use href="#icon-pin"></use></svg>' : ''}</div>
                    <div class="chat-time">${chat.time}</div>
                </div>
                <div class="chat-row-2">
                    <div class="chat-last-msg">${chat.lastMsg}</div>
                    ${chat.unread > 0 ? `<div class="unread-badge">${chat.unread}</div>` : ''}
                </div>
            </div>
        `;
        list.appendChild(div);
    });
}

function selectChat(id) {
    currentChatId = id;
    const chat = chats.find(c => c.id === id);
    
    // Обновляем шапку
    document.getElementById('activeName').textContent = chat.name;
    document.getElementById('activeStatus').textContent = chat.online ? 'в сети' : 'был(а) недавно';
    const av = document.getElementById('activeAvatar');
    av.textContent = chat.avatarStr;
    av.style.background = chat.color;
    document.getElementById('activeOnline').className = `online-dot ${chat.online ? 'active' : ''}`;
    
    // Обновляем инфо панель
    document.getElementById('infoName').textContent = chat.name;
    document.getElementById('infoStatus').textContent = chat.online ? 'в сети' : 'был(а) недавно';
    const infAv = document.getElementById('infoAvatar');
    infAv.textContent = chat.avatarStr;
    infAv.style.background = chat.color;

    // Рендер активных классов в списке
    document.querySelectorAll('.chat-item').forEach(el => el.classList.remove('active'));
    const activeItem = Array.from(document.querySelectorAll('.chat-item')).find(el => el.querySelector('.chat-name').textContent.includes(chat.name.split(' ')[0]));
    if(activeItem) activeItem.classList.add('active');

    // Мобильный вид - скрываем сайдбар при выборе чата
    if(window.innerWidth <= 768) {
        document.getElementById('sidebar').classList.add('hidden-mobile');
    }

    renderMessages(id);
}

function renderMessages(chatId) {
    const area = document.getElementById('messagesArea');
    const typingIndicator = document.getElementById('typingIndicator');
    area.innerHTML = '';
    
    // Если это первый чат, загружаем наши сгенерированные 200 сообщений
    const messagesToRender = chatId === 'c1' ? generatedHistory : [
        { type: 'date', text: 'Сегодня' },
        { type: 'msg', text: chats.find(c=>c.id===chatId).lastMsg, out: false, time: '10:00', read: true }
    ];

    messagesToRender.forEach(msg => {
        if(msg.type === 'date') {
            const div = document.createElement('div');
            div.className = 'date-divider';
            div.innerHTML = `<span>${msg.text}</span>`;
            area.appendChild(div);
        } else {
            appendMessageNode(msg.text, msg.out, msg.time, msg.read);
        }
    });
    
    area.appendChild(typingIndicator); // Переносим индикатор в конец
    scrollToBottom();
}

function appendMessageNode(text, isOut, time, isRead = false) {
    const area = document.getElementById('messagesArea');
    const typingIndicator = document.getElementById('typingIndicator');
    const div = document.createElement('div');
    div.className = `message ${isOut ? 'msg-out' : 'msg-in'}`;
    
    let statusSvg = isRead ? '<use href="#icon-check-double"></use>' : '<use href="#icon-check-double"></use>'; // Упрощено для демо
    
    div.innerHTML = `
        <div class="msg-bubble">
            ${text}
            <div class="msg-meta">
                <span>${time}</span>
                ${isOut ? `<span class="msg-status"><svg>${statusSvg}</svg></span>` : ''}
            </div>
        </div>
    `;
    area.insertBefore(div, typingIndicator);
}

/* === ВЗАИМОДЕЙСТВИЯ И АНИМАЦИИ === */

function autoExpand(field) {
    field.style.height = 'inherit';
    field.style.height = (field.scrollHeight) + 'px';
}

function handleEnter(e) {
    if(e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
}

// Улучшенный индикатор набора текста (Универсальная синхронизация mobile/desktop UI)
// Разработано с учетом проблемы рассинхрона видимости индикатора на разных платформах.
function setTypingStatus(isTyping) {
    const statusEl = document.getElementById('activeStatus');
    const indicator = document.getElementById('typingIndicator');
    const chat = chats.find(c => c.id === currentChatId);
    
    if(isTyping) {
        statusEl.textContent = 'печатает...';
        statusEl.classList.add('typing');
        indicator.classList.add('active');
        scrollToBottom();
    } else {
        statusEl.textContent = chat.online ? 'в сети' : 'был(а) недавно';
        statusEl.classList.remove('typing');
        indicator.classList.remove('active');
    }
}

function sendMessage() {
    const inp = document.getElementById('messageInput');
    const text = inp.value.trim();
    if(!text) return;

    const now = new Date();
    const timeStr = `${now.getHours()}:${now.getMinutes() < 10 ? '0' : ''}${now.getMinutes()}`;
    
    appendMessageNode(text, true, timeStr, false);
    inp.value = '';
    inp.style.height = 'inherit';
    document.getElementById('micBtn').style.display = 'flex';
    document.getElementById('sendBtn').style.display = 'none';
    scrollToBottom();

    // Обновляем список чатов
    const chat = chats.find(c => c.id === currentChatId);
    chat.lastMsg = text;
    renderChats();

    // Имитация ответа собеседника
    setTimeout(() => {
        setTypingStatus(true);
        setTimeout(() => {
            setTypingStatus(false);
            appendMessageNode("Звучит круто! Посмотрю позже. 🔥", false, timeStr, true);
            chat.lastMsg = "Звучит круто! Посмотрю позже. 🔥";
            renderChats();
            scrollToBottom();
        }, 2500);
    }, 1000);
}

function scrollToBottom() {
    const area = document.getElementById('messagesArea');
    area.scrollTop = area.scrollHeight;
}

/* === UI ПЕРЕКЛЮЧАТЕЛИ === */
function toggleTheme() {
    const html = document.documentElement;
    if(html.getAttribute('data-theme') === 'dark') {
        html.setAttribute('data-theme', 'light');
    } else {
        html.setAttribute('data-theme', 'dark');
    }
}

function toggleInfoPanel(e) {
    if(e) e.stopPropagation();
    const panel = document.getElementById('infoPanel');
    panel.classList.toggle('open');
}

function toggleSidebar(e) {
    if(e) e.stopPropagation();
    document.getElementById('sidebar').classList.remove('hidden-mobile');
}

/* === СИСТЕМА ЗВОНКОВ === */
let currentCallType = '';

function startCall(type, e) {
    e.stopPropagation();
    const chat = chats.find(c => c.id === currentChatId);
    currentCallType = type;
    
    document.getElementById('callTypeText').textContent = type === 'video' ? 'Исходящий видеозвонок' : 'Исходящий аудиозвонок';
    document.getElementById('callName').textContent = chat.name;
    document.getElementById('callStatus').textContent = 'Гудки...';
    
    const av = document.getElementById('callAvatar');
    av.textContent = chat.avatarStr;
    av.style.background = chat.color;
    
    document.getElementById('incomingControls').innerHTML = `
        <button class="call-btn btn-reject" onclick="endCall()"><svg style="width:28px;height:28px;fill:none;"><use href="#icon-x"></use></svg></button>
    `;

    document.getElementById('callModal').classList.add('active');

    // Имитация ответа через 3 секунды
    setTimeout(() => {
        if(!document.getElementById('callModal').classList.contains('active')) return;
        if(type === 'video') {
            acceptVideoCall();
        } else {
            document.getElementById('callStatus').textContent = '00:01';
        }
    }, 3000);
}

function acceptVideoCall() {
    document.getElementById('callModal').classList.remove('active');
    document.getElementById('videoCallFS').classList.add('active');
}

function endCall() {
    document.getElementById('callModal').classList.remove('active');
    document.getElementById('videoCallFS').classList.remove('active');
}

// Запуск
window.onload = init;