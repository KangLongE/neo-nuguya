'use strict';

const crypto = require('node:crypto');
const { createServer } = require('node:http');
const { WebSocket, WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const MAX_MESSAGE_LENGTH = 250;
const COOLDOWN_MS = 1_500;
const SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
const topics = new Set(['잡담', '게임', '개발', '학교', '고민', '취미', '음악', '아무거나']);
const reportReasons = new Set(['부적절한 대화', '개인정보 요구', '괴롭힘', '스팸', '기타']);

const secret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
// ponytail: single-process TTL state; use Redis when running more than one server instance.
const queues = new Map();
const safety = new Map();
const reports = [];

function sign(id) {
  return crypto.createHmac('sha256', secret).update(id).digest('base64url');
}

function issueToken() {
  const id = crypto.randomUUID();
  return `${id}.${sign(id)}`;
}

function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const [id, signature] = token.split('.');
  if (!/^[0-9a-f-]{36}$/.test(id || '') || !signature) return null;
  const expected = Buffer.from(sign(id));
  const supplied = Buffer.from(signature);
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied) ? id : null;
}

function safetyStatus(score) {
  if (score >= 4) return '제한';
  if (score >= 2) return '주의';
  return '정상';
}

function safetyFor(id) {
  const current = safety.get(id);
  if (current && current.expiresAt > Date.now()) return current;
  const fresh = { score: 0, expiresAt: Date.now() + SESSION_TTL_MS };
  safety.set(id, fresh);
  return fresh;
}

function checkMessage(value, previous = '') {
  if (typeof value !== 'string') return { code: 'invalid', message: '메시지 형식이 올바르지 않습니다.' };
  const text = value.trim();
  if (!text) return { code: 'empty', message: '메시지를 입력해 주세요.' };
  if ([...text].length > MAX_MESSAGE_LENGTH) {
    return { code: 'length', message: `메시지는 ${MAX_MESSAGE_LENGTH}자까지 보낼 수 있습니다.` };
  }

  const blocked = [
    [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/iu, 'personal', '이메일 주소는 전송할 수 없습니다.'],
    [/(?:https?:\/\/|www\.)\S+/iu, 'personal', '외부 링크는 전송할 수 없습니다.'],
    [/(?:\d[\s().-]*){9,12}/u, 'personal', '전화번호로 보이는 내용은 전송할 수 없습니다.'],
    [/(?:카톡|카카오|오픈채팅|인스타|텔레그램|디스코드)\s*(?:아이디|id|주소|링크|[:：])/iu, 'personal', '연락처나 SNS 정보는 전송할 수 없습니다.'],
    [/(.)\1{7,}/su, 'spam', '같은 문자를 반복해서 보낼 수 없습니다.'],
  ].find(([pattern]) => pattern.test(text));

  if (blocked) return { code: blocked[1], message: blocked[2] };
  if (previous && previous.localeCompare(text, undefined, { sensitivity: 'accent' }) === 0) {
    return { code: 'spam', message: '같은 메시지를 연속으로 보낼 수 없습니다.' };
  }
  return { text };
}

function send(client, payload) {
  if (client?.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(payload));
}

function removeFromQueue(client) {
  if (!client.topic) return;
  const queue = queues.get(client.topic);
  if (!queue) return;
  const index = queue.indexOf(client);
  if (index >= 0) queue.splice(index, 1);
  if (!queue.length) queues.delete(client.topic);
}

function endChat(client, notifySelf = true) {
  removeFromQueue(client);
  const peer = client.peer;
  client.peer = null;
  client.topic = null;
  client.history = [];
  if (peer?.peer === client) {
    peer.peer = null;
    peer.topic = null;
    peer.history = [];
    send(peer, { type: 'ended', message: '상대가 대화를 나갔어요.' });
  }
  if (notifySelf) send(client, { type: 'ended', message: '대화를 종료했어요.' });
}

function partnerStatus(client) {
  return safetyStatus(safetyFor(client.id).score);
}

function enqueue(client, topic) {
  if (!topics.has(topic)) return send(client, { type: 'error', message: '지원하지 않는 주제예요.' });
  if (client.peer) endChat(client, false);
  removeFromQueue(client);
  client.topic = topic;

  const queue = queues.get(topic) || [];
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    if (queue[index].ws.readyState !== WebSocket.OPEN || queue[index].peer) queue.splice(index, 1);
  }
  const peerIndex = queue.findIndex((candidate) => candidate !== client && candidate.id !== client.id);
  const peer = peerIndex >= 0 ? queue.splice(peerIndex, 1)[0] : null;

  if (!peer) {
    queue.push(client);
    queues.set(topic, queue);
    return send(client, { type: 'waiting', topic, position: queue.length });
  }

  if (!queue.length) queues.delete(topic);
  client.peer = peer;
  peer.peer = client;
  client.history = [];
  peer.history = [];
  send(client, { type: 'matched', topic, partnerStatus: partnerStatus(peer) });
  send(peer, { type: 'matched', topic, partnerStatus: partnerStatus(client) });
}

function handleChatMessage(client, value) {
  if (!client.peer) return send(client, { type: 'error', message: '먼저 상대와 매칭해 주세요.' });
  const now = Date.now();
  const retryAfter = COOLDOWN_MS - (now - client.lastSentAt);
  if (retryAfter > 0) {
    return send(client, { type: 'error', message: '잠시 후 다시 보내 주세요.', retryAfter });
  }

  client.sentAt = client.sentAt.filter((time) => now - time < 10_000);
  if (client.sentAt.length >= 6) {
    return send(client, { type: 'error', message: '메시지를 너무 빠르게 보내고 있어요.', retryAfter: 2_000 });
  }

  const checked = checkMessage(value, client.lastMessage);
  if (!checked.text) {
    if (checked.code === 'personal' || checked.code === 'spam') {
      const state = safetyFor(client.id);
      state.score = Math.min(5, state.score + 1);
    }
    return send(client, { type: 'error', message: checked.message });
  }

  client.lastSentAt = now;
  client.sentAt.push(now);
  client.lastMessage = checked.text;
  const entry = { from: client.id, text: checked.text, at: now };
  client.history = [...client.history, entry].slice(-12);
  client.peer.history = [...client.peer.history, entry].slice(-12);
  send(client, { type: 'message', own: true, text: checked.text });
  send(client.peer, { type: 'message', own: false, text: checked.text });
}

function handleReport(client, reason) {
  if (!client.peer || !reportReasons.has(reason)) {
    return send(client, { type: 'error', message: '신고할 대화나 사유를 확인해 주세요.' });
  }
  // 신고 수만으로 제재하지 않는다. 고급 판정이 붙기 전까지 증거와 사유만 짧게 접수한다.
  const evidence = client.history.filter((item) => item.from === client.peer.id).slice(-6);
  reports.push({ reporterId: client.id, reportedId: client.peer.id, reason, evidence, expiresAt: Date.now() + SESSION_TTL_MS });
  endChat(client, false);
  send(client, { type: 'reported', message: '신고가 접수됐어요. 대화를 종료했습니다.' });
}

function createClient(ws, req) {
  const token = new URL(req.url, 'http://localhost').searchParams.get('token');
  const id = verifyToken(token);
  if (!id) return null;
  safetyFor(id);
  return { ws, id, topic: null, peer: null, history: [], lastSentAt: 0, lastMessage: '', sentAt: [] };
}

function handleHttp(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (req.method === 'POST' && pathname === '/session') {
    res.writeHead(201, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    return res.end(JSON.stringify({ token: issueToken(), expiresIn: SESSION_TTL_MS }));
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

function startServer(port = PORT) {
  const server = createServer(handleHttp);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4_096 });

  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname !== '/socket') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    const client = createClient(ws, req);
    if (!client) return ws.close(1008, '익명 세션이 필요합니다.');
    send(client, { type: 'ready', cooldownMs: COOLDOWN_MS, maxLength: MAX_MESSAGE_LENGTH });

    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return send(client, { type: 'error', message: '요청 형식이 올바르지 않습니다.' });
      }
      if (message.type === 'queue') enqueue(client, message.topic);
      else if (message.type === 'message') handleChatMessage(client, message.text);
      else if (message.type === 'leave') endChat(client);
      else if (message.type === 'report') handleReport(client, message.reason);
      else send(client, { type: 'error', message: '지원하지 않는 요청이에요.' });
    });

    ws.on('close', () => endChat(client, false));
    ws.on('error', () => endChat(client, false));
  });

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [id, state] of safety) if (state.expiresAt <= now) safety.delete(id);
    for (let index = reports.length - 1; index >= 0; index -= 1) {
      if (reports[index].expiresAt <= now) reports.splice(index, 1);
    }
  }, 60_000);
  timer.unref();

  return server.listen(port, () => console.log(`neo nuguya: http://localhost:${server.address().port}`));
}

if (require.main === module) startServer();

module.exports = { checkMessage, safetyStatus, startServer };
