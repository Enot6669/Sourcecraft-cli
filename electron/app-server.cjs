const net = require('node:net');
const {spawn} = require('node:child_process');
const {StringDecoder} = require('node:string_decoder');
const {cliEnvironment, killTree} = require('./run-cli.cjs');

const approvalMethods = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']);

function localPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function explainCommand(action) {
  if (action?.type === 'read') return action.path || action.name ? 'Прочитать файл: ' + (action.path || action.name) : 'Прочитать файл';
  if (action?.type === 'listFiles') return action.path ? 'Показать список файлов в папке: ' + action.path : 'Показать список файлов';
  if (action?.type === 'search') return action.query ? 'Поиск по запросу: ' + action.query : 'Выполнить поиск';
  return null;
}

function explainChange(change) {
  const kind = change.kind?.type;
  const verbs = {add: 'Создать', update: 'Изменить', delete: 'Удалить'};
  const verb = Object.hasOwn(verbs, kind) ? verbs[kind] : 'Изменение файла';
  const destination = typeof change.kind?.movePath === 'string' && change.kind.movePath;
  if (kind === 'update' && destination) return 'Переместить файл: ' + change.path + ' → ' + destination;
  return verb + ': ' + change.path;
}

function describeApproval(message, item) {
  const {params, method} = message;
  if (!params || !approvalMethods.has(method) || params.networkApprovalContext || params.additionalPermissions) return null;

  if (method === 'item/commandExecution/requestApproval') {
    const command = params.command || item?.command;
    const cwd = params.cwd || item?.cwd;
    if (typeof command !== 'string' || !command || typeof cwd !== 'string' || !cwd) return null;
    const sameCommand = !params.command || !item?.command || params.command === item.command;
    const actions = Array.isArray(params.commandActions) && params.commandActions.length
      ? params.commandActions : sameCommand ? item?.commandActions : undefined;
    const explanations = Array.isArray(actions) ? actions.map(explainCommand) : [];
    const complete = explanations.length > 0 && explanations.every(Boolean);
    return {
      title: 'Разрешить запуск команды?',
      detailsLabel: 'Точная команда',
      operations: explanations.filter(Boolean),
      summary: complete ? 'SourceCraft определил назначение команды. Сверьте его с точной командой ниже.'
        : 'SourceCraft не описал все действия этой команды. Проверьте, что она сделает, по её тексту.',
      showDetails: !complete,
      cwd,
      details: command,
    };
  }
  if (!Array.isArray(item?.changes) || !item.changes.length ||
      item.changes.some(change => typeof change.path !== 'string' || typeof change.diff !== 'string' ||
        !change.diff || (typeof params.grantRoot === 'string' && params.grantRoot))) return null;
  return {
    title: 'Разрешить изменение файлов?',
    detailsLabel: 'Точные изменения',
    summary: 'Агент применит предложенные изменения к перечисленным файлам.',
    operations: item.changes.map(explainChange),
    details: item.changes.map(change => change.path + '\n' + change.diff).join('\n\n'),
  };
}

function describeActivity(item) {
  switch (item.type) {
    case 'commandExecution':
      if (Array.isArray(item.commandActions) && item.commandActions.length) {
        return item.commandActions.map(action => {
          if (action.type === 'read') return 'Чтение файла ' + (action.path || action.name);
          if (action.type === 'listFiles') return 'Просмотр файлов ' + (action.path || '');
          if (action.type === 'search') return 'Поиск ' + (action.query || '');
          return 'Команда: ' + (action.command || item.command);
        }).join('\n');
      }
      return 'Команда: ' + item.command;
    case 'fileChange': return 'Изменения файлов\n' + (item.changes || []).map(change => change.path).join('\n');
    case 'mcpToolCall': return 'Инструмент: ' + item.server + '/' + item.tool;
    case 'webSearch': return 'Поиск в сети: ' + (item.query || '');
    default: return '';
  }
}

async function runServerTurn(file, {cwd, prompt, threadId, signal, onEvent, registerDecision}) {
  const port = await localPort();
  if (signal.aborted) return {status: 'cancelled'};
  const address = 'ws://127.0.0.1:' + port;
  const child = spawn(file, ['codex', 'serve', '--port', String(port)], {
    cwd, env: cliEnvironment(), windowsHide: true, detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  });

  let socket;
  let closed = false;
  let failure;
  let startupText = '';
  let started = false;
  let sequence = 0;
  let turnId;
  let currentThread;
  let interruptTimer;
  const pending = new Map();
  const approvals = new Map();
  const seenApprovals = new Set();
  const items = new Map();
  const streamed = new Map();

  let readyResolve;
  let doneResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const done = new Promise(resolve => { doneResolve = resolve; });

  function terminate(message) {
    if (closed) return;
    closed = true;
    failure = message;
    readyResolve(false);
    for (const request of pending.values()) request.reject(new Error(message));
    pending.clear();
    doneResolve({status: signal.aborted ? 'cancelled' : 'failed', message});
  }

  function send(message) {
    if (socket?.readyState !== WebSocket.OPEN) throw Error('Соединение с SourceCraft CLI закрыто');
    socket.send(JSON.stringify(message));
  }

  function call(method, params) {
    return new Promise((resolve, reject) => {
      if (closed) return reject(Error(failure));
      const id = ++sequence;
      send({id, method, params});
      pending.set(id, {resolve, reject});
    });
  }

  function answer(id, result) {
    send({id, result});
  }

  function forget(key) {
    approvals.delete(key);
    onEvent({type: 'approvalResolved', key});
  }

  function decide(key, accepted) {
    const approval = approvals.get(key);
    if (!approval || typeof accepted !== 'boolean' || (accepted && !approval.canAccept)) return false;
    answer(approval.id, {decision: accepted ? 'accept' : 'decline'});
    forget(key);
    return true;
  }

  function serverRequest(message) {
    const {id, method, params} = message;
    if (!approvalMethods.has(method)) {
      if (method === 'item/permissions/requestApproval') answer(id, {permissions: {}, scope: 'turn'});
      else send({id, error: {code: -32601, message: 'Request type not supported by Studio'}});
      return;
    }
    const key = String(id);
    if (seenApprovals.has(key)) return;
    seenApprovals.add(key);
    const review = params?.threadId === currentThread && (!turnId || params.turnId === turnId)
      ? describeApproval(message, items.get(params.itemId)) : null;
    const allowed = !Array.isArray(params?.availableDecisions) || params.availableDecisions.includes('accept');
    if (!review || !allowed || review.details.length > 80_000 || signal.aborted) {
      answer(id, {decision: 'decline'});
      onEvent({type: 'activity', text: 'Запрос отклонён: Studio не может показать или подтвердить это действие.'});
      return;
    }
    approvals.set(key, {id, canAccept: true});
    onEvent({type: 'approval', key, ...review, reason: String(params.reason || '').slice(0, 4000)});
  }

  function notification(method, params) {
    if (params.threadId && params.threadId !== currentThread) return;
    if (params.turnId && turnId && params.turnId !== turnId) return;
    if (method === 'turn/started') {
      turnId = params.turn.id;
    } else if (method === 'turn/completed') {
      const turn = params.turn;
      doneResolve({status: signal.aborted || turn.status === 'interrupted' ? 'cancelled'
        : turn.status === 'completed' ? 'completed' : 'failed', message: turn.error?.message});
    } else if (method === 'serverRequest/resolved') {
      const key = String(params.requestId);
      if (approvals.has(key)) forget(key);
    } else if (method === 'item/started') {
      items.set(params.item.id, params.item);
      const text = describeActivity(params.item);
      if (text) onEvent({type: 'activity', text: text.slice(0, 4000)});
    } else if (method === 'item/completed') {
      const item = params.item;
      items.delete(item.id);
      if (item.type === 'agentMessage' && typeof item.text === 'string') {
        onEvent({type: 'answer', key: item.id, text: item.text.slice(0, 160_000)});
      } else if (item.type === 'reasoning' && !streamed.has(item.id) && Array.isArray(item.summary) && item.summary.length) {
        onEvent({type: 'activity', text: item.summary.join('\n').slice(0, 12000)});
      }
    } else if (method === 'item/agentMessage/delta' || method === 'item/reasoning/summaryTextDelta' ||
        method === 'item/plan/delta') {
      streamed.set(params.itemId, true);
      onEvent({type: 'delta', key: params.itemId, text: String(params.delta || '').slice(0, 32000),
        role: method === 'item/agentMessage/delta' ? 'answer' : 'activity'});
    }
  }

  function receive(event) {
    try {
      const message = JSON.parse(event.data);
      if (message.method && message.id !== undefined) serverRequest(message);
      else if (message.id !== undefined) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) request?.reject(Error(message.error.message || 'Ошибка протокола CLI'));
        else request?.resolve(message.result);
      } else if (message.method) notification(message.method, message.params || {});
    } catch (error) {
      terminate(error.message);
    }
  }

  function collect(chunk, decoder) {
    startupText = (startupText + decoder.write(chunk)).slice(-6000);
    // Only connect after the spawned CLI reports binding its loopback server.
    if (!closed && !started && startupText.includes(address)) {
      started = true;
      socket = new WebSocket(address);
      socket.addEventListener('open', () => readyResolve(true), {once: true});
      socket.addEventListener('message', receive);
      socket.addEventListener('close', () => terminate('Соединение с SourceCraft CLI закрыто'));
      socket.addEventListener('error', () => terminate('Не удалось подключиться к серверу SourceCraft CLI'));
    }
  }

  for (const stream of [child.stdout, child.stderr]) {
    const decoder = new StringDecoder('utf8');
    stream.on('data', chunk => collect(chunk, decoder));
  }
  child.once('error', error => terminate(error.message));
  child.once('exit', code => terminate('SourceCraft CLI завершился (' + code + '). Проверьте авторизацию и установку Codex в CLI.'));
  const startupTimer = setTimeout(() => terminate('Сервер SourceCraft CLI не запустился вовремя.'), 45000);
  const taskTimer = setTimeout(() => terminate('Превышено время ожидания ответа агента.'), 15 * 60_000);
  const cancel = () => {
    if (!turnId || closed) return terminate('Выполнение остановлено');
    for (const key of approvals.keys()) decide(key, false);
    call('turn/interrupt', {threadId: currentThread, turnId}).catch(() => terminate('Выполнение остановлено'));
    interruptTimer = setTimeout(() => terminate('Выполнение остановлено'), 5000);
  };
  signal.addEventListener('abort', cancel, {once: true});

  try {
    if (!await ready) return await done;
    await call('initialize', {clientInfo: {name: 'sourcecraft_studio', version: require('../package.json').version}});
    send({method: 'initialized'});
    const config = {cwd, approvalPolicy: 'on-request', sandbox: 'workspace-write'};
    const {thread} = threadId ? await call('thread/resume', {...config, threadId})
      : await call('thread/start', config);
    currentThread = thread.id;
    onEvent({type: 'thread', threadId: currentThread});
    clearTimeout(startupTimer);
    registerDecision(decide);
    const result = await call('turn/start', {threadId: currentThread, input: [{type: 'text', text: prompt, textElements: []}]});
    turnId ||= result.turn.id;
    return await done;
  } catch (error) {
    return {status: signal.aborted ? 'cancelled' : 'failed', message: error.message};
  } finally {
    closed = true;
    clearTimeout(startupTimer);
    clearTimeout(taskTimer);
    clearTimeout(interruptTimer);
    signal.removeEventListener('abort', cancel);
    registerDecision(null);
    socket?.close();
    await killTree(child).catch(() => {});
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

module.exports = {runServerTurn, describeApproval, describeActivity};
