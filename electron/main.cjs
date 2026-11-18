const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {pathToFileURL} = require('node:url');
const {runCli} = require('./run-cli.cjs');
const {app, BrowserWindow, ipcMain, dialog} = require('electron');
const {resolveWithin, within} = require('./paths.cjs');
const {checkAuth, checkExecutable, findCli} = require('./cli.cjs');

const devUrl = 'http://127.0.0.1:5173/';
const indexPath = path.join(__dirname, '../dist/index.html');
const useDevServer = !app.isPackaged && process.argv.includes('--studio-dev');
const rendererUrl = useDevServer ? devUrl : pathToFileURL(indexPath).href;
const fileLimit = 2 * 1024 * 1024;

let win;
let root = null;
let activeTask = null;
let cliPath = '';
let savingSettings = false;
let allowClose = false;
let rendererReady = false;

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

async function loadSettings() {
  try {
    const settings = JSON.parse(await fs.readFile(settingsFile(), 'utf8'));
    if (typeof settings.cliPath === 'string' && path.isAbsolute(settings.cliPath)) cliPath = settings.cliPath;
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not read CLI settings', error);
  }
}

async function saveSettings(selectedPath) {
  const file = settingsFile();
  const temporary = file + '.' + randomUUID() + '.tmp';
  await fs.mkdir(path.dirname(file), {recursive: true});
  try {
    await fs.writeFile(temporary, JSON.stringify({cliPath: selectedPath}, null, 2), 'utf8');
    await fs.rename(temporary, file);
    cliPath = selectedPath;
  } finally {
    await fs.rm(temporary, {force: true}).catch(() => {});
  }
}

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function handle(channel, callback) {
  ipcMain.handle(channel, (event, ...args) => {
    const frame = event.senderFrame;
    if (!win || event.sender !== win.webContents || frame !== win.webContents.mainFrame ||
        frame?.url !== rendererUrl) throw Error('Недопустимый источник запроса');
    return callback(...args);
  });
}

function createWindow() {
  allowClose = false;
  rendererReady = false;
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600, backgroundColor: '#0d111b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.on('close', event => {
    if (allowClose || !rendererReady || win.webContents.getURL() !== rendererUrl || win.webContents.isCrashed()) return;
    event.preventDefault();
    send('editor:requestClose');
  });
  win.on('closed', () => { win = null; });
  const loading = useDevServer ? win.loadURL(devUrl) : win.loadFile(indexPath);
  loading.catch(() => dialog.showErrorBox('SourceCraft Studio', 'Не удалось открыть интерфейс. Для разработки используйте npm run desktop:dev.'));
}

app.whenReady().then(async () => {
  await loadSettings();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', event => {
  if (!activeTask) return;
  event.preventDefault();
  stopTask(activeTask).then(() => app.quit());
});

async function listFiles(directory) {
  const output = [];
  const ignored = new Set(['.git', 'node_modules', 'dist', 'release', '.next', 'build']);
  async function walk(folder, depth) {
    if (depth > 5 || output.length >= 700) return;
    for (const entry of await fs.readdir(folder, {withFileTypes: true})) {
      if (output.length >= 700) break;
      if (ignored.has(entry.name)) continue;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile()) output.push(path.relative(directory, full));
    }
  }
  await walk(directory, 0);
  return output;
}

handle('project:choose', async () => {
  if (activeTask) throw Error('Дождитесь завершения задачи');
  const result = await dialog.showOpenDialog(win, {properties: ['openDirectory']});
  if (result.canceled) return null;
  const directory = await fs.realpath(result.filePaths[0]);
  const files = await listFiles(directory);
  root = directory;
  return {root, files};
});

async function checkedFile(relative) {
  const directory = root;
  if (!directory) throw Error('Сначала откройте проект');
  const file = await fs.realpath(resolveWithin(directory, relative));
  if (!within(directory, file)) throw Error('Ссылка ведёт за пределы проекта');
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > fileLimit) throw Error('Можно открыть только файл размером до 2 МБ');
  return file;
}

async function readText(file) {
  const bytes = await fs.readFile(file);
  if (bytes.includes(0)) throw Error('Редактор поддерживает текстовые файлы UTF-8');
  try {
    return new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
  } catch {
    throw Error('Редактор поддерживает текстовые файлы UTF-8');
  }
}

handle('file:read', async relative => readText(await checkedFile(relative)));
handle('file:save', async (relative, text, expected) => {
  if (typeof text !== 'string' || Buffer.byteLength(text) > fileLimit) throw Error('Размер файла превышает 2 МБ');
  const file = await checkedFile(relative);
  if (await readText(file) !== expected) throw Error('Файл изменился на диске. Скопируйте правки перед повторным открытием файла.');
  await fs.writeFile(file, text, 'utf8');
});

handle('editor:confirm', async count => {
  if (!Number.isInteger(count) || count < 1) throw Error('Некорректное число файлов');
  const {response} = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Несохранённые правки',
    message: count === 1 ? 'В одном файле есть несохранённые правки.' : 'В нескольких файлах есть несохранённые правки.',
    buttons: ['Сохранить', 'Отбросить', 'Отмена'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  return ['save', 'discard', 'cancel'][response];
});

handle('editor:close', async () => {
  if (activeTask) await stopTask(activeTask);
  allowClose = true;
  win.close();
});

handle('settings:get', () => ({cliPath}));
handle('settings:choose', async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: process.platform === 'win32' ? [{name: 'Приложения Windows', extensions: ['exe']}] : [],
  });
  return result.canceled ? null : result.filePaths[0];
});
handle('settings:setCliPath', async value => {
  if (activeTask || savingSettings) throw Error('Дождитесь завершения текущей операции');
  if (typeof value !== 'string' || value.length > 2048) throw Error('Некорректный путь');
  const selectedPath = value.trim().replace(/^"(.*)"$/, '$1');
  if (selectedPath && (!path.isAbsolute(selectedPath) ||
      (process.platform === 'win32' && path.extname(selectedPath).toLowerCase() !== '.exe'))) {
    throw Error('Укажите абсолютный путь к src.exe');
  }
  savingSettings = true;
  try {
    const result = selectedPath ? await checkExecutable(selectedPath) : await findCli('');
    if (!selectedPath || result.ok) await saveSettings(selectedPath);
    return {...result, saved: !selectedPath || result.ok};
  } finally {
    savingSettings = false;
  }
});
handle('agent:check', () => {
  rendererReady = true;
  return findCli(cliPath);
});
handle('agent:auth', async () => {
  const directory = root;
  const status = await findCli(cliPath);
  if (!status.ok) return {status: 'unavailable', message: status.message};
  return checkAuth(status.path, directory);
});

async function stopTask(task) {
  task.controller.abort();
  const result = await task.finished.catch(() => null);
  return result?.status !== 'stop-failed';
}

handle('agent:run', async (prompt, agent) => {
  const directory = root;
  if (!directory) throw Error('Сначала откройте проект');
  if (activeTask || savingSettings) throw Error('Дождитесь завершения текущей операции');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 12000) throw Error('Введите задачу длиной до 12 000 символов');
  const flags = {ycodex: '--ycodex', codex: '--codex'};
  if (!Object.hasOwn(flags, agent)) throw Error('Этот агент не поддерживается');

  const task = {controller: new AbortController(), finished: null};
  activeTask = task;
  task.finished = (async () => {
    const {signal} = task.controller;
    const cli = await findCli(cliPath, undefined, signal);
    if (signal.aborted) return {status: 'cancelled', code: -1};
    if (!cli.ok) throw Error(cli.message);
    return runCli(cli.path, ['do', flags[agent], '--', prompt], {
      cwd: directory,
      signal,
      onOutput: text => send('agent:output', {text}),
    });
  })().finally(() => { activeTask = null; });
  return task.finished;
});

handle('agent:cancel', () => activeTask ? stopTask(activeTask) : false);
