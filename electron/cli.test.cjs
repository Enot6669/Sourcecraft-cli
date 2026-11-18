const test = require('node:test');
const assert = require('node:assert/strict');
const {authStatus, candidates, execute, readVersion} = require('./cli.cjs');

test('finds absolute PATH entries and the official Windows installation directory', () => {
  assert.deepEqual(candidates('win32', {
    Path: '"C:\\Tools With Spaces";.;C:\\Tools With Spaces',
    LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local',
  }), [
    'C:\\Tools With Spaces\\src.exe',
    'C:\\Users\\Test\\AppData\\Local\\Programs\\src\\src.exe',
  ]);
});

test('parses official version output and rejects generic CLI help', () => {
  assert.equal(readVersion('Version:    0.0.122\r\nGit Commit: 07f4efc4d277044c3\r\nBuild Type: release\r\n'), '0.0.122');
  assert.equal(readVersion('help for src.exe\nUnknown flag: --version'), '');
  assert.equal(readVersion('Version: 1.2.3\n'), '');
});

test('distinguishes unauthenticated, verified, and failed status without exposing CLI output', () => {
  assert.deepEqual(authStatus({ok: false, stdout: '', stderr: "OPERATION FAILED: Authentication required\nHINT: Run 'src auth login'"}),
    {status: 'signed-out', message: 'Требуется вход в SourceCraft. Выполните src auth login в терминале.'});
  assert.equal(authStatus({ok: true, stdout: 'Logged in', stderr: ''}).status, 'signed-in');
  assert.equal(authStatus({ok: false, stdout: '', stderr: 'HTTP 401 (sensitive details)'}).status, 'signed-out');
  const result = authStatus({ok: false, stdout: '', stderr: 'HTTP 503 (sensitive details)'});
  assert.equal(result.status, 'error');
  assert.doesNotMatch(result.message, /sensitive/);
});

test('captures stdout and stderr separately and closes stdin', async () => {
  const result = await execute(process.execPath, ['-e', "process.stdin.resume(); process.stdin.on('end', () => { console.log('out'); console.error('err'); })"]);
  assert.equal(result.ok, true);
  assert.equal(result.stdout.trim(), 'out');
  assert.equal(result.stderr.trim(), 'err');
});
