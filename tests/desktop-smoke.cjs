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
  const {app, BrowserWindow, dialog, clipboard} = electron;
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
        fs.writeFile(path.join(project, 'do'), [
          'if (process.argv[2] !== "--ycodex" || process.argv[3] !== "--") process.exit(2);',
          'if (process.argv[4] === "cancel me") {',
          '  console.log("CANCEL_READY");',
          '  setInterval(() => {}, 100);',
          '} else if (process.argv[4] === "needs approval") {',
          '  console.error("headless Codex execution requires approval; use interactive src codex");',
          '  process.exitCode = -1;',
          '} else {',
          '  process.stderr.write("\\x1b[2K⠋ Starting up...\\x1b[2K⠹ Connected\\r\\n");',
          '  process.stdout.write("Old value\\rNew value\\r\\n");',
          '  for (let i = 0; i < 700; i++) console.log("Line " + i);',
          '  console.log("LAST_LINE");',
          '}',
        ].join('\n')),
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

      await js('(() => { const select = document.querySelector(".composer select"); select.value = "ycodex"; select.dispatchEvent(new Event("change", {bubbles: true})); })()');
      await input('.composer textarea', 'long output');
      await click('.composer button', 'Запустить');
      await waitForText('.chat', 'Задача завершена');
      for (const selector of ['.chat', '.terminal pre']) {
        assert.equal(await has(selector, 'LAST_LINE'), true, selector + ' lost its final line');
        assert.equal(await has(selector, 'New value'), true);
        for (const discarded of ['Old value', 'Starting up', 'Connected', '\x1b']) {
          assert.equal(await has(selector, discarded), false, selector + ' leaked ' + discarded);
        }
        const metrics = await js('(() => { const el = document.querySelector(' + JSON.stringify(selector) +
          '); return {top: el.scrollTop, height: el.scrollHeight, visible: el.clientHeight}; })()');
        assert.ok(metrics.visible > 0 && metrics.height > metrics.visible, selector + ' is not scrollable');
        assert.ok(metrics.height - metrics.top - metrics.visible < 2, selector + ' did not follow output');
      }
      await js('document.querySelector(".chat").scrollTop = 0; document.querySelector(".chat").dispatchEvent(new Event("scroll"));');
      await input('.composer textarea', 'cancel me');
      await click('.composer button', 'Запустить');
      await waitForText('.chat', 'CANCEL_READY');
      assert.equal(await js('document.querySelector(".chat").scrollTop'), 0, 'chat moved while reading older output');
      await click('.composer button', 'Остановить');
      await waitForText('.chat', 'Задача отменена');
      await input('.composer textarea', 'needs approval');
      await click('.composer button', 'Запустить');
      await waitForText('.chat', 'Агенту нужно ваше подтверждение');
      await click('.approval-actions button', 'Скопировать команду');
      await waitForText('.approval-actions', 'Команда скопирована');
      assert.equal(await clipboard.readText(), "Set-Location -LiteralPath '" + await fs.realpath(project) +
        "' -ErrorAction Stop; & '" + path.join(cliDir, 'src.exe') + "' ycodex");
      await click('.approval-actions button', 'Скопировать запрос');
      await waitForText('.approval-actions', 'Запрос скопирован');
      assert.equal(await clipboard.readText(), 'needs approval');
      assert.equal(await js('[...document.querySelectorAll(".message")].slice(-2).map(el => el.classList[1]).join(",")'), 'agent,result');
      await click('.chat-toolbar button', 'Новый чат');
      await waitFor(() => js('document.querySelector(".chat-toolbar select").options.length === 2'), 'saved chat available');
      await js('(() => { const select = document.querySelector(".chat-toolbar select"); select.selectedIndex = 1; select.dispatchEvent(new Event("change", {bubbles: true})); })()');
      await waitForText('.chat', 'LAST_LINE');
      await click('.chat-toolbar button', 'Новый чат');
      await waitFor(() => js('document.querySelector(".composer select").value === "chat"'), 'interactive chat');
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
      console.log('Desktop smoke passed: CLI detection, authentication UI, editor save, clean output, scroll, cancellation');
    } finally {
      process.chdir(os.tmpdir());
    }
  }

  verify().then(() => app.exit(0), error => {
    console.error(error);
    app.exit(1);
  });
}
