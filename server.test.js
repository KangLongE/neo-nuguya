'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { checkMessage, safetyStatus } = require('./server');
const { startServer } = require('./server');

test('메시지 안전 규칙과 상태 단계를 지킨다', () => {
  assert.equal(checkMessage('안녕하세요').text, '안녕하세요');
  assert.equal(checkMessage('hello@example.com').code, 'personal');
  assert.equal(checkMessage('010-1234-5678').code, 'personal');
  assert.equal(checkMessage('도배', '도배').code, 'spam');
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
