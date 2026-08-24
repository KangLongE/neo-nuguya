'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const appServer = require('./server');
const { checkMessage, safetyStatus, startServer } = appServer;

test('Vercel이 호출할 HTTP 서버를 기본으로 내보낸다', () => {
  assert.equal(typeof appServer.listen, 'function');
  assert.equal(typeof appServer.emit, 'function');
});

test('메시지 안전 규칙과 상태 단계를 지킨다', () => {
  assert.equal(checkMessage('안녕하세요').text, '안녕하세요');
  assert.equal(checkMessage('hello@example.com').code, 'personal');
  assert.equal(checkMessage('010-1234-5678').code, 'personal');
  assert.equal(checkMessage('도배', '도배').text, '도배');
  assert.equal(checkMessage('가'.repeat(251)).code, 'length');
  assert.equal(safetyStatus(0), '정상');
  assert.equal(safetyStatus(2), '주의');
  assert.equal(safetyStatus(4), '제한');
});

function nextMessage(socket, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${type} 응답 시간 초과`)), 2_000);
    const onMessage = (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type !== type) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(event);
    };
    socket.on('message', onMessage);
  });
}

test('두 익명 사용자를 매칭하고 메시지를 전달한다', async (context) => {
  const server = startServer(0);
  await once(server, 'listening');
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  const unauthorized = new WebSocket(`ws://127.0.0.1:${port}/socket`);
  const [closeCode] = await once(unauthorized, 'close');
  assert.equal(closeCode, 1008);

  const session = async () => (await (await fetch(`${origin}/session`, { method: 'POST' })).json()).token;
  const [tokenA, tokenB] = await Promise.all([session(), session()]);
  const socketA = new WebSocket(`ws://127.0.0.1:${port}/socket?token=${encodeURIComponent(tokenA)}`);
  const socketB = new WebSocket(`ws://127.0.0.1:${port}/socket?token=${encodeURIComponent(tokenB)}`);

  context.after(async () => {
    socketA.close();
    socketB.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const readyA = nextMessage(socketA, 'ready');
  const readyB = nextMessage(socketB, 'ready');
  await Promise.all([once(socketA, 'open'), once(socketB, 'open'), readyA, readyB]);

  const waiting = nextMessage(socketA, 'waiting');
  socketA.send(JSON.stringify({ type: 'queue', topic: '개발' }));
  assert.equal((await waiting).topic, '개발');

  const matchedA = nextMessage(socketA, 'matched');
  const matchedB = nextMessage(socketB, 'matched');
  socketB.send(JSON.stringify({ type: 'queue', topic: '개발' }));
  assert.equal((await matchedA).partnerStatus, '정상');
  assert.equal((await matchedB).topic, '개발');

  const sent = nextMessage(socketA, 'message');
  const received = nextMessage(socketB, 'message');
  socketA.send(JSON.stringify({ type: 'message', text: '안녕하세요!' }));
  assert.equal((await sent).own, true);
  assert.equal((await received).text, '안녕하세요!');

  const rateLimited = nextMessage(socketA, 'error');
  socketA.send(JSON.stringify({ type: 'message', text: '너무 빠른 두 번째 메시지' }));
  assert.ok((await rateLimited).retryAfter > 0);
});

test('HTTP CORS 및 정적 웹 파일 서빙을 지원한다', async (context) => {
  const server = startServer(0);
  await once(server, 'listening');
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  // OPTIONS preflight check
  const optionsRes = await fetch(`${origin}/session`, { method: 'OPTIONS' });
  assert.equal(optionsRes.status, 204);
  assert.equal(optionsRes.headers.get('access-control-allow-origin'), '*');

  // Health endpoint check
  const healthRes = await fetch(`${origin}/health`);
  assert.equal(healthRes.status, 200);
  const healthData = await healthRes.json();
  assert.equal(healthData.ok, true);
  assert.equal(healthRes.headers.get('access-control-allow-origin'), '*');

  // Static web serving check (GET / -> index.html)
  const webRes = await fetch(`${origin}/`);
  assert.equal(webRes.status, 200);
  assert.ok(webRes.headers.get('content-type').includes('text/html'));
  const htmlContent = await webRes.text();
  assert.ok(htmlContent.includes('neo nuguya'));
  assert.ok(htmlContent.includes('누구인지 말고'));
});

test('사용자 간 대화 종료 및 알림이 정상 전달된다', async (context) => {
  const server = startServer(0);
  await once(server, 'listening');
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  const session = async () => (await (await fetch(`${origin}/session`, { method: 'POST' })).json()).token;
  const [tokenA, tokenB] = await Promise.all([session(), session()]);
  const socketA = new WebSocket(`ws://127.0.0.1:${port}/socket?token=${encodeURIComponent(tokenA)}`);
  const socketB = new WebSocket(`ws://127.0.0.1:${port}/socket?token=${encodeURIComponent(tokenB)}`);

  context.after(async () => {
    socketA.close();
    socketB.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const readyA = nextMessage(socketA, 'ready');
  const readyB = nextMessage(socketB, 'ready');
  await Promise.all([once(socketA, 'open'), once(socketB, 'open'), readyA, readyB]);

  const matchedA = nextMessage(socketA, 'matched');
  const matchedB = nextMessage(socketB, 'matched');
  socketA.send(JSON.stringify({ type: 'queue', topic: '게임' }));
  socketB.send(JSON.stringify({ type: 'queue', topic: '게임' }));
  await Promise.all([matchedA, matchedB]);

  // A leaves the chat -> B should receive ended notification
  const endedB = nextMessage(socketB, 'ended');
  socketA.send(JSON.stringify({ type: 'leave' }));
  const bNotification = await endedB;
  assert.equal(bNotification.message, '상대가 대화를 나갔어요.');
});
