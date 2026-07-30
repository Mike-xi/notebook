import assert from 'node:assert/strict';
import WebSocket from 'ws';

const base = new URL(process.argv[2] || 'https://sjtu.ccwu.cc/starpost-app/');
const socketURL = new URL('ws/proxy-smoke-not-a-conversation', base);
socketURL.protocol = socketURL.protocol === 'https:' ? 'wss:' : 'ws:';

const status = await new Promise((resolve, reject) => {
  const socket = new WebSocket(socketURL, {
    headers: { Origin: base.origin },
  });
  const timer = setTimeout(() => {
    socket.terminate();
    reject(new Error('WebSocket proxy probe timed out'));
  }, 10_000);

  socket.once('unexpected-response', (_request, response) => {
    clearTimeout(timer);
    response.resume();
    socket.terminate();
    resolve(response.statusCode);
  });
  socket.once('open', () => {
    clearTimeout(timer);
    socket.close();
    reject(new Error('Unauthenticated WebSocket probe unexpectedly opened'));
  });
  socket.once('error', (error) => {
    clearTimeout(timer);
    reject(error);
  });
});

assert.equal(status, 401);
console.log(JSON.stringify({ ok: true, socketURL: String(socketURL), status }));
