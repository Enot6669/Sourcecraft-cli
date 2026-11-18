const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const electron = require('electron');

if (typeof electron === 'string') {
  const {spawnSync} = require('node:child_process');
  const run = spawnSync(electron, [__filename, process.execPath], {
    stdio: 'inherit', timeout: 90_000, windowsHide: true,
  });
  if (run.error) console.error(run.error);
  process.exitCode = run.status ?? 1;
} else {
  const {app, BrowserWindow, dialog} = electron;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function verify() {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-desktop-'));
    const project = path.join(scratch, 'project');
    const cliDir = path.join(scratch, 'cli');
    const userData = path.join(scratch, 'profile');
    await Promise.all([project, cliDir, userData].map(folder => fs.mkdir(folder)));
    try {
      const node = process.argv.at(-1);
      await fs.copyFile(node, path.join(cliDir, 'src.exe'));
      const fixture = path.join(project, 'notes.txt');
      await Promise.all([
        fs.writeFile(fixture, 'Original'),
        fs.writeFile(path.join(project, 'version'), 'console.log("Version: 0.0.122\\nGit Commit: 12345678");'),
        fs.copyFile(path.join(__dirname, 'fixture-app-server.cjs'), path.join(project, 'codex')),
        fs.writeFile(path.join(project, 'auth'), 'process.exitCode = process.argv[2] === "status" ? 0 : 1;'),
      ]);
      app.setPath('userData', userData);
      process.chdir(project);
      process.env.PATH = cliDir + path.delimiter + process.env.PATH;
      // Bypass just the native folder picker. The app still lists and opens the
      // selected folder and runs all renderer-to-main IPC handlers normally.
      dialog.showOpenDialog = async () => ({canceled: false, filePaths: [project]});
      require('../electron/main.cjs');
      await app.whenReady();
      async function waitFor(check, label) {
        const expires = Date.now() + 15_000;
        while (Date.now() < expires) {
          if (await check()) return;
          await delay(100);
        }
        throw new Error('Timed out: ' + label);
      }
      await waitFor(() => Boolean(BrowserWindow.getAllWindows()[0]), 'window');
      const win = BrowserWindow.getAllWindows()[0];
      const js = expression => win.webContents.executeJavaScript(expression);
      const has = (selector, value) => js('document.querySelector(' + JSON.stringify(selector) +
        ')?.textContent.includes(' + JSON.stringify(value) + ')');
      const click = (selector, label) => js('Array.from(document.querySelectorAll(' +
        JSON.stringify(selector) + ')).find(button => button.textContent.includes(' +
        JSON.stringify(label) + ')).click()');
      const input = (selector, value) => js('(() => { const field = document.querySelector(' +
        JSON.stringify(selector) + '); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")' +
        '.set.call(field, ' + JSON.stringify(value) + '); field.dispatchEvent(new Event("input", {bubbles: true})); })()');
      const waitForText = (selector, value) => waitFor(() => has(selector, value), selector + ': ' + value);

      await waitForText('.status', 'CLI найден');
      await click('.sidebar button', 'Настройки CLI');
      await waitFor(() => js('!!document.querySelector(".settings-result")'), 'CLI settings');
      await waitFor(() => js('[...document.querySelectorAll(".settings-panel button")].some(b => b.textContent.includes("Проверить авторизацию") && !b.disabled)'), 'CLI settings ready');
      await click('.settings-panel button', 'Проверить авторизацию');
      await waitForText('.settings-result', 'Вход выполнен');
      await click('.settings-panel button', '✕');

      await click('.sidebar button', 'Открыть проект');
      await waitForText('.files', 'notes.txt');
      await click('.files button', 'notes.txt');
      await waitFor(() => js('document.querySelector(".code")?.value === "Original"'), 'editor contents');
      await input('.code', 'Updated');
      await waitFor(() => js('[...document.querySelectorAll(".tabs button")].some(b => b.textContent.includes("Сохранить") && !b.disabled)'), 'save enabled');
      await click('.tabs button', 'Сохранить');
      await waitFor(async () => (await fs.readFile(fixture, 'utf8')) === 'Updated', 'file saved');

      await input('.composer textarea', 'Подтверждение в Studio');
      await click('.composer button', 'Запустить');
      await waitForText('.approval-panel', 'Get-Content notes.txt');
      await waitForText('.chat', 'Чтение файла notes.txt');
      await waitForText('.chat', 'Сначала проверю notes.txt.');
      assert.equal(await has('.chat', 'PRIVATE_NOT_SHOWN'), false);
      assert.equal(await has('.chat', 'Подтверждение получено.'), false);
      await click('.approval-panel button', 'Разрешить один раз');
      await waitForText('.chat', 'Подтверждение получено.');
      await waitForText('.chat', 'Задача завершена');
      await waitFor(() => js('[...document.querySelectorAll(".composer button")].some(b => b.textContent === "Запустить")'), 'ready for next turn');
      await input('.composer textarea', 'Продолжить чат');
      await click('.composer button', 'Запустить');
      await waitForText('.approval-panel', 'Get-Content notes.txt');
      await click('.approval-panel button', 'Отклонить');
      await waitForText('.chat', 'Отказ получен.');
      await waitFor(() => js('[...document.querySelectorAll(".composer button")].some(b => b.textContent === "Запустить")'), 'ready to cancel');
      await input('.composer textarea', 'Остановить текущую задачу');
      await click('.composer button', 'Запустить');
      await waitForText('.approval-panel', 'Get-Content notes.txt');
      await click('.composer button', 'Остановить');
      await waitForText('.chat', 'Задача отменена');
      await waitFor(() => js('[...document.querySelectorAll(".composer button")].some(b => b.textContent === "Запустить")'), 'second turn done');
      await click('.chat-toolbar button', 'Новый чат');
      await waitFor(() => js('document.querySelector(".chat-toolbar select").options.length === 2'), 'saved chat available');
      await js('(() => { const select = document.querySelector(".chat-toolbar select"); select.selectedIndex = 1; select.dispatchEvent(new Event("change", {bubbles: true})); })()');
      await waitForText('.chat', 'Подтверждение получено.');
      await waitForText('.chat', 'Отказ получен.');
      console.log('Desktop smoke passed: CLI detection, authentication UI, editor save, approvals, action feed, chat history');
    } finally {
      process.chdir(os.tmpdir());
    }
  }

  verify().then(() => app.exit(0), error => {
    console.error(error);
    app.exit(1);
  });
}
