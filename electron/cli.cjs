const {execFile} = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const {cliEnvironment} = require('./run-cli.cjs');

function execute(file, args, {cwd, timeout = 8000, signal} = {}) {
  return new Promise(resolve => {
    const process = execFile(file, args, {cwd, timeout, signal, env: cliEnvironment(), windowsHide: true, maxBuffer: 64 * 1024},
      (error, stdout, stderr) => resolve({
        ok: !error,
        stdout,
        stderr,
        timedOut: error?.killed === true,
      }));
    process.stdin?.end();
  });
}

function candidates(platform, env) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const name = platform === 'win32' ? 'src.exe' : 'src';
  const dirs = (env.PATH || env.Path || '').split(paths.delimiter)
    .map(dir => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter(dir => paths.isAbsolute(dir));
  if (platform === 'win32' && paths.isAbsolute(env.LOCALAPPDATA || '')) {
    dirs.push(paths.join(env.LOCALAPPDATA, 'Programs', 'src'));
  }
  return [...new Set(dirs.map(dir => paths.join(dir, name)))];
}

function readVersion(stdout) {
  const match = stdout.match(/^Version:\s*(v?\d+\.\d+\.\d+(?:[-+][a-z0-9.+-]+)?)\s*$/im);
  return match && /^Git Commit:\s*[0-9a-f]{7,}\s*$/im.test(stdout) ? match[1] : '';
}

async function probe(file, cwd, signal) {
  const stat = await fs.stat(file).catch(() => null);
  if (signal?.aborted || !stat?.isFile()) return null;

  const result = await execute(file, ['version'], {cwd, signal});
  const version = result.ok ? readVersion(result.stdout) : '';
  const message = version ? 'SourceCraft CLI готов к работе.'
    : result.timedOut ? 'SourceCraft CLI не ответил вовремя.' : 'Файл не прошёл проверку SourceCraft CLI.';
  return {ok: Boolean(version), path: file, version, message};
}

async function checkExecutable(file, cwd, signal) {
  return await probe(file, cwd, signal) ?? {ok: false, path: file, version: '', message: 'Файл CLI не найден.'};
}

async function findCli(manualPath, cwd, signal) {
  if (manualPath) return checkExecutable(manualPath, cwd, signal);

  let failure;
  for (const file of candidates(process.platform, process.env)) {
    if (signal?.aborted) break;
    const status = await probe(file, cwd, signal);
    if (status?.ok) return status;
    failure ??= status;
  }
  return failure ?? {
    ok: false, path: '', version: '',
    message: 'SourceCraft CLI не найден. Установите его или выберите src.exe вручную.',
  };
}

function authStatus({ok, stdout, stderr, timedOut}) {
  const output = stdout + '\n' + stderr;
  if (/authentication required|not (?:logged|signed) in|unauthenticated|\bHTTP\s+401\b/i.test(output)) {
    return {status: 'signed-out', message: 'Требуется вход в SourceCraft. Выполните src auth login в терминале.'};
  }
  if (ok) return {status: 'signed-in', message: 'Вход в SourceCraft подтверждён.'};
  return {
    status: 'error',
    message: timedOut ? 'Проверка входа не ответила вовремя.' : 'Не удалось проверить вход в SourceCraft.',
  };
}

async function checkAuth(file, cwd) {
  return authStatus(await execute(file, ['auth', 'status'], {cwd}));
}

module.exports = {authStatus, candidates, checkAuth, checkExecutable, execute, findCli, readVersion};
