import React, {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import './style.css';
import {ProjectFiles} from './project-files.jsx';
import {version} from '../package.json';

const api = window.studio;
const terminalLimit = 200000;
const cleanError = error => error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
const taskResults = {
  completed: 'Задача завершена',
  cancelled: 'Задача отменена',
  'output-limit': 'Задача остановлена по лимиту вывода',
  'startup-timeout': 'Агент не начал отвечать вовремя. Проверьте подключение и авторизацию CLI.',
  timeout: 'Задача остановлена по истечении времени ожидания.',
  'stop-failed': 'Не удалось завершить процесс CLI.',
};
const resultText = result => taskResults[result.status] || result.message || 'Ошибка выполнения, код ' + result.code;
const authLabels = {
  'signed-in': 'Вход выполнен',
  'signed-out': 'Требуется вход',
  unavailable: 'CLI недоступен',
  error: 'Ошибка проверки',
};

function appendOutput(previous, chunk) {
  const text = previous.text + chunk;
  return {
    ...previous,
    text: text.slice(-terminalLimit),
    truncated: previous.truncated || text.length > terminalLimit,
  };
}

function outputText({text, truncated}) {
  return truncated ? '[Начало вывода скрыто из-за ограничения размера]\n' + text : text;
}

function groupChatMessages(messages) {
  const rows = [];
  let work;
  messages.forEach((message, index) => {
    if (message.role === 'user') work = undefined;
    if (message.role !== 'activity') {
      rows.push({...message, id: index});
    } else {
      if (!work) {
        work = {role: 'work', id: index, events: []};
        rows.push(work);
      }
      work.events.push(message);
    }
  });
  return rows;
}

function ApprovalCard({request, remaining, busy, error, onDecision}) {
  return <section className="approval-panel" aria-label="Подтверждение агента">
    <div className="approval-request">
      <div className="approval-heading">
        <b>{request.title}</b>
        {remaining > 0 && <small>В очереди ещё: {remaining}</small>}
      </div>
      <div className="approval-review">
        <p>{request.summary}</p>
        {request.operations.length > 0 && <ul className="approval-operations">
          {request.operations.map((operation, index) => <li key={index}>{operation}</li>)}
        </ul>}
        {request.cwd && <p><strong>Рабочая папка</strong> {request.cwd}</p>}
        {request.reason && <p><strong>Зачем агент просит</strong> {request.reason}</p>}
        <details open={request.showDetails || undefined} className="approval-details">
          <summary>{request.detailsLabel}</summary>
          <pre tabIndex={0}>{request.details}</pre>
        </details>
      </div>
      <div className="approval-footer">
        <p>Решение действует только для этого запроса.</p>
        <div className="approval-actions">
          <button className="primary" disabled={busy} onClick={() => onDecision(request, true)}>Разрешить один раз</button>
          <button disabled={busy} onClick={() => onDecision(request, false)}>Отклонить</button>
        </div>
        {error && <p role="alert">{error}</p>}
      </div>
    </div>
  </section>;
}

function useFollowOutput(content, visible = true) {
  const ref = useRef(null);
  const follow = useRef(true);

  function onScroll(event) {
    const {scrollTop, scrollHeight, clientHeight} = event.currentTarget;
    follow.current = scrollHeight - scrollTop - clientHeight < 32;
  }

  useLayoutEffect(() => {
    const element = ref.current;
    if (element && follow.current) element.scrollTop = element.scrollHeight;
  }, [content, visible]);

  return {ref, onScroll};
}

function CliSettings({diagnostic, setDiagnostic, running, close}) {
  const [cliPath, setCliPath] = useState('');
  const [check, setCheck] = useState(null);
  const [auth, setAuth] = useState(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    api.getSettings().then(settings => setCliPath(settings.cliPath))
      .catch(error => setNotice(cleanError(error))).finally(() => setBusy(false));
  }, []);

  async function perform(action) {
    setBusy(true);
    setNotice('');
    try {
      await action();
    } catch (error) {
      setNotice(cleanError(error));
    } finally {
      setBusy(false);
    }
  }

  function showCheck(result) {
    setCheck(result);
    setDiagnostic(result);
  }

  function savePath(value) {
    return perform(async () => {
      setAuth(null);
      const result = await api.setCliPath(value);
      setCheck(result);
      if (result.saved) {
        setDiagnostic(result);
        setCliPath((await api.getSettings()).cliPath);
        setNotice('Настройки сохранены.');
      } else {
        setNotice('Путь не сохранён. Проверьте файл или включите автопоиск.');
      }
    });
  }

  const displayed = check ?? diagnostic;

  return <div className="settings-overlay">
    <section className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="cli-title">
      <div className="settings-title">
        <h2 id="cli-title">Настройки SourceCraft CLI</h2>
        <button onClick={close} aria-label="Закрыть настройки">✕</button>
      </div>
      <p>Studio ищет src.exe в PATH и в стандартной папке установки SourceCraft.</p>
      <label htmlFor="cli-path">Путь к исполняемому файлу</label>
      <div className="settings-row">
        <input id="cli-path" disabled={busy} value={cliPath} onChange={event => setCliPath(event.target.value)}
          placeholder="Автоматический поиск" />
        <button disabled={busy} onClick={() => perform(async () => {
          const file = await api.chooseCli();
          if (file) setCliPath(file);
        })}>Обзор</button>
      </div>
      <div className="settings-row">
        <button className="primary" disabled={busy || running} onClick={() => savePath(cliPath)}>Сохранить путь</button>
        <button disabled={busy || running} onClick={() => savePath('')}>Включить автопоиск</button>
        <button disabled={busy} onClick={() => perform(async () => {
          setAuth(null);
          showCheck(await api.checkCli());
        })}>Проверить CLI</button>
        <button disabled={busy} onClick={() => perform(async () => setAuth(await api.checkAuth()))}>
          Проверить авторизацию
        </button>
      </div>
      <div className="settings-result" aria-live="polite">
        <b>{busy ? 'Выполняется проверка…' : displayed?.ok ? 'SourceCraft CLI найден' : 'SourceCraft CLI недоступен'}</b>
        {displayed?.path && <p><b>Файл</b> {displayed.path}</p>}
        {displayed?.version && <p><b>Версия</b> {displayed.version}</p>}
        {displayed?.message && <p>{displayed.message}</p>}
        {auth && <p><b>{authLabels[auth.status]}</b> {auth.message}</p>}
        {notice && <p>{notice}</p>}
      </div>
    </section>
  </div>;
}

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [diagnostic, setDiagnostic] = useState(null);
  const [root, setRoot] = useState('');
  const [files, setFiles] = useState([]);
  const [fileRevision, setFileRevision] = useState(0);
  const [tabs, setTabs] = useState([]);
  const [active, setActive] = useState('');
  const [drafts, setDrafts] = useState({});
  const [saved, setSaved] = useState({});
  const [prompt, setPrompt] = useState('');
  const [chatId, setChatId] = useState('');
  const [threadId, setThreadId] = useState('');
  const [chatList, setChatList] = useState([]);
  const [historyError, setHistoryError] = useState('');
  const [approvals, setApprovals] = useState([]);
  const [decisionBusy, setDecisionBusy] = useState('');
  const [decisionError, setDecisionError] = useState('');
  const [messages, setMessages] = useState([]);
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [editorBusy, setEditorBusy] = useState(false);
  const [terminal, setTerminal] = useState({text: '', truncated: false});
  const [showTerminal, setShowTerminal] = useState(true);
  const editorLock = useRef(false);
  const taskLock = useRef(false);
  const nextTaskId = useRef(0);
  const currentTaskId = useRef(null);
  const currentThreadId = useRef('');
  const checkInitial = useRef(true);
  const chatScroll = useFollowOutput(messages);
  const terminalScroll = useFollowOutput(terminal, showTerminal);

  useEffect(() => {
    api.checkCli().then(result => {
      document.title = 'SourceCraft Studio v.' + version;
      if (checkInitial.current) setDiagnostic(result);
    }).catch(error => {
      if (checkInitial.current) setDiagnostic({ok: false, message: cleanError(error)});
    });
    const stopOutput = api.onOutput(({result}) => {
      if (result) setTerminal(previous => appendOutput(previous, '\n[' + resultText(result) + ']\n'));
    });
    const stopEvents = api.onAgentEvent(({taskId, type, key, text, role, ...details}) => {
      if (taskId !== currentTaskId.current) return;
      if (type === 'thread') {
        currentThreadId.current = details.threadId;
        setThreadId(details.threadId);
      } else if (type === 'approval') {
        setApprovals(previous => previous.some(item => item.key === key) ? previous :
          [...previous, {taskId, key, ...details}]);
      } else if (type === 'approvalResolved') {
        setApprovals(previous => previous.filter(item => item.key !== key));
      } else if (type === 'activity' && text) {
        setTerminal(previous => appendOutput(previous, text + '\n'));
        setMessages(previous => [...previous, {role: 'activity', text}]);
      } else if (type === 'delta' || type === 'answer') {
        const itemRole = type === 'answer' || role === 'answer' ? 'agent' : 'activity';
        setMessages(previous => {
          const existing = previous.findIndex(item => item.key === key && item.turn === taskId && item.role === itemRole);
          const item = {role: itemRole, key, turn: taskId, text};
          if (existing === -1) return [...previous, item];
          return previous.map((old, index) => index !== existing ? old :
            type === 'answer' ? item : appendOutput(old, text));
        });
      }
    });
    return () => { stopOutput(); stopEvents(); };
  }, []);

  function snapshot() {
    if (!root || !chatId || !messages.length) return null;
    return {id: chatId, title: messages.find(item => item.role === 'user')?.text || 'Новый чат',
      threadId, messages};
  }

  async function persist() {
    const chat = snapshot();
    if (!chat) return;
    await api.saveChat(root, chat);
  }

  useEffect(() => {
    if (!root || !chatId || !messages.length) return;
    const timer = setTimeout(() => {
      persist().then(() => setHistoryError('')).catch(error => setHistoryError(cleanError(error)));
    }, 350);
    return () => clearTimeout(timer);
  }, [root, chatId, messages, threadId]);

  function showChat(chat) {
    currentTaskId.current = null;
    setChatId(chat?.id || crypto.randomUUID());
    currentThreadId.current = chat?.threadId || '';
    setThreadId(currentThreadId.current);
    setMessages(chat?.messages || []);
    setPrompt('');
    setApprovals([]);
    setDecisionError('');
    setTerminal({text: '', truncated: false});
  }

  async function switchChat(id) {
    if (taskLock.current) return;
    await edit(async () => {
      await persist();
      const savedChats = await api.listChats();
      setChatList(savedChats);
      showChat(savedChats.find(item => item.id === id));
    });
  }

  async function decide(approval, accept) {
    if (decisionBusy) return;
    setDecisionBusy(approval.key);
    setDecisionError('');
    try {
      const sent = await api.decide(approval.taskId, approval.key, accept);
      if (!sent) throw Error('Этот запрос уже закрыт.');
      setMessages(previous => [...previous, {
        role: 'activity', text: (accept ? 'Разрешено: ' : 'Отклонено: ') + (approval.operations[0] || approval.title.replace(/\?$/, '')),
      }]);
      setApprovals(previous => previous.filter(item => item.key !== approval.key));
    } catch (error) {
      setDecisionError(cleanError(error));
    } finally {
      setDecisionBusy('');
    }
  }

  function updateDiagnostic(result) {
    checkInitial.current = false;
    setDiagnostic(result);
  }

  async function edit(action) {
    if (editorLock.current) return;
    editorLock.current = true;
    setEditorBusy(true);
    try {
      await action();
    } catch (error) {
      alert(cleanError(error));
    } finally {
      editorLock.current = false;
      setEditorBusy(false);
    }
  }

  async function saveFile(file) {
    await api.saveFile(file, drafts[file], saved[file]);
    setSaved(previous => ({...previous, [file]: drafts[file]}));
  }

  async function confirmEdits(selectedTabs) {
    const dirty = selectedTabs.filter(file => drafts[file] !== saved[file]);
    if (dirty.length === 0) return true;
    const choice = await api.confirmEdits(dirty.length);
    if (choice === 'cancel') return false;
    if (choice === 'save') {
      for (const file of dirty) await saveFile(file);
    }
    return choice === 'save' || choice === 'discard';
  }

  useEffect(() => api.onCloseRequest(() => {
    edit(async () => {
      if (await confirmEdits(tabs)) {
        await persist();
        await api.closeWindow();
      }
    });
  }));

  function openProject() {
    if (taskLock.current) return;
    return edit(async () => {
      if (!await confirmEdits(tabs)) return;
      await persist();
      const project = await api.chooseProject();
      if (!project) return;
      setRoot(project.root);
      setFiles(project.files);
      setFileRevision(revision => revision + 1);
      setTabs([]);
      setActive('');
      setDrafts({});
      setSaved({});
      const savedChats = await api.listChats();
      setChatList(savedChats);
      showChat(savedChats[0]);
    });
  }

  function openFile(file) {
    return edit(async () => {
      if (!tabs.includes(file)) {
        const content = await api.readFile(file);
        setDrafts(previous => ({...previous, [file]: content}));
        setSaved(previous => ({...previous, [file]: content}));
        setTabs(previous => [...previous, file]);
      }
      setActive(file);
    });
  }

  function closeTab(file) {
    return edit(async () => {
      if (!await confirmEdits([file])) return;
      const remaining = tabs.filter(tab => tab !== file);
      setTabs(remaining);
      if (active === file) setActive(remaining.at(-1) || '');
      setDrafts(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== file)));
      setSaved(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== file)));
    });
  }

  async function run() {
    if (!prompt.trim() || taskLock.current || editorLock.current || !root || !diagnostic?.ok) return;
    taskLock.current = true;
    const question = prompt;
    const taskId = ++nextTaskId.current;
    currentTaskId.current = taskId;
    setDecisionError('');
    setPrompt('');
    setMessages(previous => [...previous, {role: 'user', text: question}]);
    setRunning(true);
    try {
      const result = await api.runTask(question, taskId, currentThreadId.current);
      setMessages(previous => [...previous, {
        role: 'result', taskId, text: resultText(result),
      }]);
    } catch (error) {
      setMessages(previous => [...previous, {role: 'error', text: cleanError(error)}]);
    } finally {
      setApprovals([]);
      try { setFiles(await api.refreshProject()); } catch { /* keep the current list */ }
      setFileRevision(revision => revision + 1);
      taskLock.current = false;
      setRunning(false);
    }
  }

  async function cancel() {
    setCancelling(true);
    try {
      const stopped = await api.cancelTask();
      if (!stopped && taskLock.current) throw Error('Не удалось остановить процесс CLI.');
    } catch (error) {
      setMessages(previous => [...previous, {role: 'error', text: cleanError(error)}]);
    } finally {
      setCancelling(false);
    }
  }

  const cliLabel = diagnostic ? diagnostic.ok ? 'CLI найден' : 'CLI недоступен' : 'Проверка CLI…';
  const canSwitch = !editorBusy && !running;

  return <>
    <div className="app" inert={settingsOpen}>
      <aside className="sidebar">
        <div className="brand"><span className="logo">⌘</span><div><strong>SourceCraft</strong><small>STUDIO</small></div></div>
        <button className="primary" disabled={!canSwitch} onClick={openProject}>📁 Открыть проект</button>
        <div className="section">ФАЙЛЫ ПРОЕКТА</div>
        <div className="path">{root || 'Выберите папку проекта'}</div>
        <ProjectFiles key={root} entries={files} root={root} revision={fileRevision} active={active}
          disabled={editorBusy} onOpenFile={openFile} readFolder={api.readFolder} />
        <button className="sourcecraft-usage" title="Просмотреть квоту и расход нейрокредитов в браузере"
          onClick={() => api.openUsage().catch(error => alert(cleanError(error)))}>
          Квоты SourceCraft <span aria-hidden="true">↗</span>
        </button>
        <button onClick={() => setSettingsOpen(true)}>⚙ Настройки CLI</button>
        <div className="foot">Локальная работа с проектом</div>
      </aside>
      <main className="editor">
        <div className="tabs">
          {tabs.length === 0 ? <span className="tab">Редактор</span> : tabs.map(file =>
            <span className={'tab ' + (file === active ? 'on' : '')} key={file}
              onClick={() => { if (!editorLock.current) setActive(file); }}>
              {file.split(/[\\/]/).at(-1)}{drafts[file] !== saved[file] ? ' ●' : ''}
              <button disabled={editorBusy} aria-label={'Закрыть ' + file}
                onClick={event => { event.stopPropagation(); closeTab(file); }}>×</button>
            </span>
          )}
          <button className={'status ' + (diagnostic?.ok ? 'ready' : '')} onClick={() => setSettingsOpen(true)}>{cliLabel} ⚙</button>
          <button onClick={() => edit(() => saveFile(active))} disabled={editorBusy || !active || drafts[active] === saved[active]}>
            💾 Сохранить
          </button>
        </div>
        {active ? <textarea spellCheck="false" className="code" readOnly={editorBusy} value={drafts[active] ?? ''}
          onChange={event => setDrafts(previous => ({...previous, [active]: event.target.value}))} />
          : <div className="welcome"><div className="hero">⌘</div><h1>Ваша среда разработки</h1>
            <p>Откройте проект и выберите файл слева</p>
            <button className="primary" disabled={!canSwitch} onClick={openProject}>Открыть папку</button>
          </div>}
        <div className="terminal">
          <button className="terminal-head" onClick={() => setShowTerminal(value => !value)}>
            ⌘ Терминал агента <span>{showTerminal ? '⌄' : '⌃'}</span>
          </button>
          {showTerminal && <pre {...terminalScroll} tabIndex={0} aria-label="Вывод терминала">
            {terminal.text ? outputText(terminal) : 'Вывод команд появится здесь после запуска задачи.'}
          </pre>}
        </div>
      </main>
      <section className="assistant">
        <header>✧ AI Ассистент <small>SourceCraft CLI</small></header>
        <div className="chat-toolbar">
          <select aria-label="История чатов" value={chatList.some(chat => chat.id === chatId) ? chatId : ''}
            disabled={!root || running || editorBusy} onChange={event => switchChat(event.target.value)}>
            <option value="">{messages.find(item => item.role === 'user')?.text.slice(0, 55) || 'Новый чат'}</option>
            {chatList.map(chat => <option key={chat.id} value={chat.id}>{chat.title}</option>)}
          </select>
          <button disabled={!root || running || editorBusy} onClick={() => switchChat('')}>Новый чат</button>
        </div>
        {historyError && <p className="history-error" role="status">{historyError}</p>}
        <div className="chat" {...chatScroll} tabIndex={0} role="region" aria-label="Диалог с ассистентом">
          {messages.length === 0 ? <div className="welcome-chat"><b>SOURCECRAFT</b>
            <p>Откройте проект и отправьте задачу в чат SourceCraft.</p>
          </div> : groupChatMessages(messages).map(message => message.role === 'work' ?
            <details key={message.id} className="message activity work-log">
              <summary>Ход работы <small>{message.events.length}</small></summary>
              <ul>{message.events.map((event, index) => <li key={index}><pre>{outputText(event)}</pre></li>)}</ul>
            </details> :
            <div key={message.id} className={'message ' + message.role} hidden={message.role === 'agent' && !message.text}>
              <b>{{user: 'Вы', agent: 'Агент', error: 'Ошибка', result: 'Статус'}[message.role]}</b><pre>{outputText(message)}</pre>
            </div>
          )}
        </div>
        {running && approvals.length > 0 && <ApprovalCard key={approvals[0].key} request={approvals[0]}
          remaining={approvals.length - 1} busy={Boolean(decisionBusy)} error={decisionError} onDecision={decide} />}
        <div className="composer">
          <textarea maxLength={12000} value={prompt} onChange={event => setPrompt(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && event.ctrlKey) { event.preventDefault(); run(); }
            }}
            placeholder={root ? 'Опишите задачу для агента' : 'Сначала откройте папку проекта'} />
          <div className="actions">
            <small>{running ? approvals.length ? 'Ожидает решения' : 'Агент работает…'
              : diagnostic?.ok ? 'Ctrl + Enter — отправить' : 'Подключите SourceCraft CLI в настройках'}</small>
            {running ? <button onClick={cancel} disabled={cancelling}>{cancelling ? 'Остановка…' : 'Остановить'}</button>
              : <button className="primary" disabled={editorBusy || !root || !prompt.trim() || !diagnostic?.ok}
                onClick={run}>Запустить</button>}
          </div>
        </div>
      </section>
    </div>
    {settingsOpen && <CliSettings diagnostic={diagnostic} setDiagnostic={updateDiagnostic}
      running={running} close={() => setSettingsOpen(false)} />}
  </>;
}

if (api) createRoot(document.getElementById('root')).render(<App />);
else document.getElementById('root').textContent = 'Откройте SourceCraft Studio в desktop-приложении.';
