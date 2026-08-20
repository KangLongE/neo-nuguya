'use strict';

const screens = [...document.querySelectorAll('.screen')];
const connectionStatus = document.querySelector('#connectionStatus');
const notice = document.querySelector('#notice');
const messageInput = document.querySelector('#messageInput');
const sendButton = document.querySelector('#sendButton');
const charCount = document.querySelector('#charCount');
const messages = document.querySelector('#messages');
const reportDialog = document.querySelector('#reportDialog');

let socket;
let currentScreen = 'welcomeScreen';
let chatting = false;
let coolingDown = false;
let reconnectTimer;

function showScreen(id) {
  currentScreen = id;
  for (const screen of screens) screen.hidden = screen.id !== id;
}

function showNotice(message) {
  notice.textContent = message;
  notice.hidden = false;
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => { notice.hidden = true; }, 3_500);
}

function setConnected(connected) {
  connectionStatus.classList.toggle('connected', connected);
  connectionStatus.lastChild.textContent = connected ? ' 연결됨' : ' 연결 중';
  updateSendButton();
}

function connect() {
  clearTimeout(reconnectTimer);
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/socket`);
  socket.addEventListener('open', () => setConnected(true));
  socket.addEventListener('close', () => {
    setConnected(false);
    if (currentScreen === 'waitingScreen' || currentScreen === 'chatScreen') {
      chatting = false;
      showScreen('topicScreen');
      showNotice('연결이 끊겼어요. 주제를 다시 선택해 주세요.');
    }
    reconnectTimer = setTimeout(connect, 1_500);
  });
  socket.addEventListener('message', ({ data }) => handleServerMessage(JSON.parse(data)));
}

function send(payload) {
  if (socket?.readyState !== WebSocket.OPEN) return showNotice('서버에 다시 연결하고 있어요.');
  socket.send(JSON.stringify(payload));
}

function addMessage(text, kind) {
  const bubble = document.createElement('div');
  bubble.className = `message ${kind}`;
  bubble.textContent = text;
  messages.append(bubble);
  messages.scrollTop = messages.scrollHeight;
}

function startCooldown(duration = 1_500) {
  coolingDown = true;
  const startedAt = performance.now();
  const tick = (now) => {
    const progress = Math.min((now - startedAt) / duration, 1);
    sendButton.style.setProperty('--progress', `${progress * 360}deg`);
    if (progress < 1) requestAnimationFrame(tick);
    else {
      coolingDown = false;
      sendButton.style.setProperty('--progress', '360deg');
      updateSendButton();
    }
  };
  updateSendButton();
  requestAnimationFrame(tick);
}

function updateSendButton() {
  sendButton.disabled = !chatting || coolingDown || !messageInput.value.trim() || socket?.readyState !== WebSocket.OPEN;
}

function handleServerMessage(event) {
  if (event.type === 'waiting') {
    document.querySelector('#waitingTopic').textContent = event.topic;
    document.querySelector('#waitingCopy').textContent = event.position > 1
      ? `현재 ${event.position}번째로 기다리고 있어요.`
      : '같은 주제의 누군가가 들어오면 바로 연결할게요.';
    showScreen('waitingScreen');
  }
  if (event.type === 'matched') {
    chatting = true;
    messages.replaceChildren();
    document.querySelector('#chatTopic').textContent = event.topic;
    const warning = document.querySelector('#partnerWarning');
    warning.hidden = event.partnerStatus === '정상';
    warning.textContent = event.partnerStatus === '제한'
      ? '최근 여러 차례 채팅 규칙을 위반한 사용자예요. 불편하면 바로 나가 주세요.'
      : '최근 채팅에서 주의를 받은 사용자예요.';
    showScreen('chatScreen');
    addMessage('연결됐어요. 가볍게 인사해 보세요.', 'system');
    messageInput.focus();
    updateSendButton();
  }
  if (event.type === 'message') {
    addMessage(event.text, event.own ? 'own' : 'partner');
    if (event.own) startCooldown();
  }
  if (event.type === 'error') {
    showNotice(event.message);
    if (event.retryAfter) startCooldown(event.retryAfter);
  }
  if (event.type === 'ended') {
    chatting = false;
    showScreen('topicScreen');
    showNotice(event.message);
  }
  if (event.type === 'reported') {
    chatting = false;
    showScreen('topicScreen');
    showNotice(event.message);
  }
}

document.querySelector('#startButton').addEventListener('click', () => showScreen('topicScreen'));
document.querySelector('#backButton').addEventListener('click', () => showScreen('welcomeScreen'));
document.querySelectorAll('[data-topic]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelector('#waitingTopic').textContent = button.dataset.topic;
    showScreen('waitingScreen');
    send({ type: 'queue', topic: button.dataset.topic });
  });
});

document.querySelector('#cancelButton').addEventListener('click', () => {
  send({ type: 'leave' });
  showScreen('topicScreen');
});

document.querySelector('#leaveButton').addEventListener('click', () => {
  chatting = false;
  send({ type: 'leave' });
  showScreen('topicScreen');
});

document.querySelector('#reportButton').addEventListener('click', () => reportDialog.showModal());
document.querySelector('#reportForm').addEventListener('submit', (event) => {
  const reason = new FormData(event.currentTarget).get('reason');
  if (!reason) {
    event.preventDefault();
    return showNotice('신고 사유를 선택해 주세요.');
  }
  send({ type: 'report', reason });
  event.currentTarget.reset();
});

messageInput.addEventListener('input', () => {
  charCount.textContent = `${[...messageInput.value].length} / 250`;
  messageInput.style.height = 'auto';
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 100)}px`;
  updateSendButton();
});

messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    if (!sendButton.disabled) document.querySelector('#messageForm').requestSubmit();
  }
});

document.querySelector('#messageForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text || sendButton.disabled) return;
  send({ type: 'message', text });
  messageInput.value = '';
  messageInput.style.height = 'auto';
  charCount.textContent = '0 / 250';
  updateSendButton();
});

connect();
