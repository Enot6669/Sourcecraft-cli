// Minimal WebSocket peer for the smoke test. It never executes a command.
const http = require('node:http');
const {createHash} = require('node:crypto');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const fixedThread = '01962990-839a-7100-848e-6c31dad71d51';

const server = http.createServer();
server.on('upgrade', (request, socket, head) => {
  const nonce = request.headers['sec-websocket-key'];
  const digest = createHash('sha1').update(nonce + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + digest + '\r\n\r\n');
  let buffer = Buffer.alloc(0);
  function send(json) {
    const data = Buffer.from(JSON.stringify(json));
    const header = data.length < 126 ? Buffer.from([129, data.length]) : Buffer.alloc(4);
    if (header.length === 4) {
      header[0] = 129;
      header[1] = 126;
      header.writeUInt16BE(data.length, 2);
    }
    socket.write(Buffer.concat([header, data]));
  }
  const context = {threadId: fixedThread, turnId: 'turn-1'};
  function handle(message) {
    const {id, method, params, result} = message;
    if (method === 'initialize') send({id, result: {userAgent: 'fixture app-server'}});
    if (method === 'thread/start' || method === 'thread/resume') {
      if (params.approvalPolicy !== 'on-request' || params.sandbox !== 'workspace-write' ||
          (method === 'thread/resume' && params.threadId !== fixedThread)) {
        send({id, error: {code: -32602, message: 'Unexpected thread configuration'}});
      } else send({id, result: {thread: {id: fixedThread}}});
    }
    if (method === 'turn/start') {
      const item = {id: 'command-1', type: 'commandExecution', cwd: process.cwd(), command: 'Get-Content notes.txt',
        commandActions: [{type: 'read', path: 'notes.txt'}]};
      send({id, result: {turn: {id: context.turnId}}});
      send({method: 'item/reasoning/summaryTextDelta', params: {...context, itemId: 'reasoning-1', delta: 'Сначала проверю notes.txt.'}});
      send({method: 'item/reasoning/textDelta', params: {...context, itemId: 'reasoning-1', delta: 'PRIVATE_NOT_SHOWN'}});
      send({method: 'item/started', params: {...context, item}});
      send({id: 'review-1', method: 'item/commandExecution/requestApproval',
        params: {...context, itemId: item.id, command: item.command, cwd: item.cwd, reason: 'Тест подтверждения'}});
    }
    if (id === 'review-1' && result) {
      send({method: 'serverRequest/resolved', params: {threadId: fixedThread, requestId: id}});
      send({method: 'item/completed', params: {...context,
        item: {type: 'agentMessage', id: 'answer-1', text: result.decision === 'accept' ? 'Подтверждение получено.' : 'Отказ получен.'}}});
      send({method: 'turn/completed', params: {threadId: fixedThread, turn: {id: context.turnId, status: 'completed'}}});
    }
  }
  function read(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 15;
      const width = (buffer[1] & 127) === 126 ? 4 : 2;
      if (buffer.length < width) return;
      const length = width === 4 ? buffer.readUInt16BE(2) : buffer[1] & 127;
      if (length === 127 && width === 2) return socket.destroy();
      const offset = width + 4; // Client data is masked.
      if (buffer.length < offset + length) return;
      if (opcode === 8) return socket.end();
      const data = Buffer.alloc(length);
      for (let i = 0; i < length; i++) data[i] = buffer[offset + i] ^ buffer[width + (i % 4)];
      buffer = buffer.subarray(offset + length);
      if (opcode === 1) handle(JSON.parse(data.toString('utf8')));
    }
  }
  socket.on('data', read);
  if (head.length) read(head);
});
server.listen(port, '127.0.0.1', () => console.error('listening on: ws://127.0.0.1:' + port));
