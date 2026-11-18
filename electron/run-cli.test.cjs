const assert = require('node:assert/strict');
const test = require('node:test');
const {OutputFilter} = require('./output.cjs');
const {runCli} = require('./run-cli.cjs');

function decode(input, chunkSize) {
  const buffer = Buffer.from(input);
  let result = '';
  const filter = new OutputFilter(text => { result += text; });
  for (let i = 0; i < buffer.length; i += chunkSize) filter.write(buffer.subarray(i, i + chunkSize));
  filter.end();
  return result;
}

test('strips split ANSI and spinner frames while preserving UTF-8, CRLF and final text', () => {
  const frames = '\x1b[?25l\x1b[2K⠋ Starting up...\r\n\x1b[2K⠹ Connected\r\n';
  const text = frames + '\x1b[31mЧерновик\x1b[0m\rОтвет\r\n' +
    '\x1b]8;;https://example.com\x1b\\ссылка\x1b]8;;\x07\n' +
    '\x1bPignored\x1b\\готово';
  for (const size of [1, 7, 1000]) assert.equal(decode(text, size), 'Ответ\nссылка\nготово');
  assert.equal(decode('\x1b[2K⠋ Starting up...\x1b[2K⠹ Connected\r\n', 1), '');
});

test('keeps line breaks, indentation and literal status words', () => {
  assert.equal(decode('Connected\r\n\n  code\t🟢\n', 2), 'Connected\n\n  code\t🟢\n');
  assert.equal(decode('a'.repeat(20_000), 100), 'a'.repeat(20_000));
});

const node = (script, options = {}, args = []) => {
  const chunks = [];
  const onOutput = text => {
    chunks.push(text);
    options.onOutput?.(text);
  };
  return runCli(process.execPath, ['-e', script, '--', ...args], {...options, onOutput})
    .then(result => ({...result, chunks, output: chunks.join('')}));
};

test('uses pipes and closed stdin, passing the prompt as a single literal argument', async () => {
  const prompt = '--help "quoted"\nnext line Ж & | >';
  const result = await node(
    'process.stdin.resume(); process.stdin.on("end", () => console.log(JSON.stringify([' +
    '!!process.stdin.isTTY, !!process.stdout.isTTY, !!process.stderr.isTTY, process.argv[1]])));',
    {}, [prompt],
  );
  assert.equal(result.status, 'completed');
  assert.deepEqual(JSON.parse(result.output), [false, false, false, prompt]);
});

test('batches burst output and flushes the final stdout and stderr fragments before completion', async () => {
  const result = await node(
    'for (let i = 0; i < 500; i++) process.stdout.write("line\\n");' +
    'process.stdout.write("final"); process.stderr.write("\\x1b[31merror\\x1b[0m");',
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.output.match(/line\n/g).length, 500);
  assert.match(result.output, /final/);
  assert.match(result.output, /error/);
  assert.doesNotMatch(result.output, /\x1b/);
  assert.ok(result.chunks.length < 20);
});

test('repeating spinner output cannot extend the startup timeout', async () => {
  const result = await node(
    'setInterval(() => process.stderr.write("\\x1b[2K⠋ Starting up...\\r\\n"), 10);',
    {startupMs: 750, timeoutMs: 5000},
  );
  assert.equal(result.status, 'startup-timeout');
  assert.equal(result.output, '');
});

test('productive output can clear the startup timer but cannot extend the overall timeout', async () => {
  const result = await node('console.log("started"); setInterval(() => console.log("busy"), 50);', {
    startupMs: 750, timeoutMs: 1200,
  });
  assert.equal(result.status, 'timeout');
  assert.match(result.output, /started/);
});

test('cancels an active process and does not launch an already cancelled process', async () => {
  const controller = new AbortController();
  const result = await node(
    'console.log("ready"); setInterval(() => {}, 100);',
    {signal: controller.signal, onOutput: () => controller.abort(), startupMs: 2000, timeoutMs: 5000},
  );
  assert.equal(result.status, 'cancelled');
  assert.equal(result.output, 'ready\n');
  const skipped = await node('console.log("unexpected");', {signal: controller.signal});
  assert.equal(skipped.status, 'cancelled');
  assert.equal(skipped.output, '');
});

test('stops following the raw byte limit even when progress is suppressed', async () => {
  const result = await node(
    'process.stderr.write("\\x1b[2K⠹ Connected\\r\\n".repeat(500)); setInterval(() => {}, 100);',
    {maxBytes: 1024, startupMs: 3000},
  );
  assert.equal(result.status, 'output-limit');
  assert.ok(result.output.length < 32);
});

test('returns a spawn error and does not keep timers alive', async () => {
  let output = '';
  const result = await runCli('sourcecraft-studio-test-missing-executable', [], {
    onOutput: text => { output += text; },
  });
  assert.equal(result.status, 'failed');
  assert.match(output, /ENOENT/);
});

test('recognizes the real headless approval error and normalizes Windows exit -1', async () => {
  const result = await node(
    'process.stderr.write("connection closed: headless Codex execution\\n");' +
    'setTimeout(() => { process.stderr.write("requires approval; use interactive src codex\\n"); process.exitCode = -1; }, 150);',
  );
  assert.equal(result.status, 'approval-required');
  assert.equal(result.code, process.platform === 'win32' ? -1 : 255);
  assert.match(result.output, /use interactive src codex/);
});

test('interactive command uses the chosen agent and quotes literal paths', () => {
  const {interactiveCommand} = require('./interactive.cjs');
  assert.equal(interactiveCommand("D:\\team's [project]", "C:\\source craft\\src.exe", 'ycodex'),
    "Set-Location -LiteralPath 'D:\\team''s [project]' -ErrorAction Stop; & 'C:\\source craft\\src.exe' ycodex");
  assert.throws(() => interactiveCommand('D:\\team', 'C:\\src.exe', 'unknown'));
});
