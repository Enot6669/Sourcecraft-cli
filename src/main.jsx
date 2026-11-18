import React, {useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import './style.css';

const api = window.studio;
const terminalLimit = 200000;
const cleanError = error => error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
const taskResults = {
  completed: 'Задача завершена',
  cancelled: 'Задача отменена',
  'output-limit': 'Задача остановлена по лимиту вывода',
};
const authLabels = {
  'signed-in': 'Вход выполнен',
  'signed-out': 'Требуется вход',
  unavailable: 'CLI недоступен',
  error: 'Ошибка проверки',
};

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
  const [tabs, setTabs] = useState([]);
  const [active, setActive] = useState('');
  const [drafts, setDrafts] = useState({});
  const [saved, setSaved] = useState({});
  const [prompt, setPrompt] = useState('');
  const [agent, setAgent] = useState('ycodex');
  const [messages, setMessages] = useState([]);
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [editorBusy, setEditorBusy] = useState(false);
  const [terminal, setTerminal] = useState('');
  const [showTerminal, setShowTerminal] = useState(true);
  const editorLock = useRef(false);
  const taskLock = useRef(false);
  const checkInitial = useRef(true);

  useEffect(() => {
    api.checkCli().then(result => {
      document.title = 'SourceCraft Studio';
      if (checkInitial.current) setDiagnostic(result);
    }).catch(error => {
      if (checkInitial.current) setDiagnostic({ok: false, message: cleanError(error)});
    });
    return api.onOutput(({text}) => {
      setTerminal(value => (value + text).slice(-terminalLimit));
      setMessages(items => {
        const last = items.at(-1);
        if (last?.role === 'agent') {
          return [...items.slice(0, -1), {...last, text: (last.text + text).slice(-terminalLimit)}];
        }
        return [...items, {role: 'agent', text: text.slice(-terminalLimit)}];
      });
    });
  }, []);

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
      if (await confirmEdits(tabs)) await api.closeWindow();
    });
  }));

  function openProject() {
    if (taskLock.current) return;
    return edit(async () => {
      if (!await confirmEdits(tabs)) return;
      const project = await api.chooseProject();
      if (!project) return;
      setRoot(project.root);
      setFiles(project.files);
      setTabs([]);
      setActive('');
      setDrafts({});
      setSaved({});
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
    setPrompt('');
    setMessages(previous => [...previous, {role: 'user', text: question}]);
    setRunning(true);
    try {
      const result = await api.runTask(question, agent);
      const status = taskResults[result.status] || 'Ошибка выполнения, код ' + result.code;
      setTerminal(previous => (previous + '\n[' + status + ']\n').slice(-terminalLimit));
      setMessages(previous => [...previous, {role: 'result', text: status}]);
    } catch (error) {
      setMessages(previous => [...previous, {role: 'error', text: cleanError(error)}]);
    } finally {
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
        <div className="files">{files.map(file =>
          <button key={file} disabled={editorBusy} className={active === file ? 'selected' : ''} onClick={() => openFile(file)}>▤ {file}</button>
        )}</div>
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
          {showTerminal && <pre>{terminal || 'Вывод команд появится здесь после запуска задачи.'}</pre>}
        </div>
      </main>
      <section className="assistant">
        <header>✧ AI Ассистент <small>Локальный CLI</small></header>
        <div className="chat">
          {messages.length === 0 ? <div className="welcome-chat"><b>SOURCECRAFT</b>
            <p>Откройте проект, выберите агента и отправьте задачу.</p>
          </div> : messages.map((message, index) =>
            <div key={index} className={'message ' + message.role}>
              <b>{{user: 'Вы', agent: 'Агент', error: 'Ошибка', result: 'Статус'}[message.role]}</b><pre>{message.text}</pre>
            </div>
          )}
        </div>
        <div className="composer">
          <select value={agent} onChange={event => setAgent(event.target.value)} aria-label="Агент">
            <option value="ycodex">YCodex</option><option value="codex">Codex</option>
          </select>
          <textarea maxLength={12000} value={prompt} onChange={event => setPrompt(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && event.ctrlKey) { event.preventDefault(); run(); }
            }}
            placeholder={root ? 'Опишите задачу для агента' : 'Сначала откройте папку проекта'} />
          <div className="actions">
            <small>{diagnostic?.ok ? 'Ctrl + Enter — отправить' : 'Подключите SourceCraft CLI в настройках'}</small>
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
