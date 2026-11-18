const path = require('node:path');
const {execFile, spawn} = require('node:child_process');
const {OutputFilter} = require('./output.cjs');

const startupTimeoutMs = 90_000;
const taskTimeoutMs = 10 * 60_000;
const outputLimit = 4 * 1024 * 1024;
const outputIntervalMs = 100;

function cliEnvironment() {
  return {...process.env, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb'};
}

function killTree(child) {
  if (!child.pid) return Promise.resolve();
  if (process.platform === 'win32') {
    const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    return new Promise(resolve => {
      execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, timeout: 5000}, error => {
        if (error && child.exitCode === null && child.signalCode === null) child.kill();
        resolve();
      });
    });
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  return Promise.resolve();
}

function runCli(file, args, {
  cwd, signal, onOutput, startupMs = startupTimeoutMs, timeoutMs = taskTimeoutMs, maxBytes = outputLimit,
}) {
  if (signal?.aborted) return Promise.resolve({status: 'cancelled', code: -1});

  const child = spawn(file, args, {
    cwd,
    env: cliEnvironment(),
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });

  return new Promise(resolve => {
    let bytes = 0;
    let outcome;
    let finished = false;
    let recentOutput = '';
    let approvalRequired = false;
    let pending = '';
    let outputTimer;
    let stopTimer;

    function flush() {
      clearTimeout(outputTimer);
      outputTimer = null;
      if (!pending) return;
      const text = pending;
      pending = '';
      onOutput(text);
    }

    function queue(text) {
      if (text.trim()) clearTimeout(startupTimer);
      if (!approvalRequired) {
        recentOutput = (recentOutput + text).slice(-4096);
        approvalRequired = /headless\s+Codex\s+execution\s+requires\s+approval/i.test(recentOutput);
      }
      pending += text;
      outputTimer ??= setTimeout(flush, outputIntervalMs);
    }

    function finish(status, code) {
      if (finished) return;
      finished = true;
      clearTimeout(startupTimer);
      clearTimeout(taskTimer);
      clearTimeout(stopTimer);
      signal?.removeEventListener('abort', cancel);
      flush();
      const exitCode = code === 0xffffffff ? -1 : (code ?? -1);
      resolve({status: status === 'failed' && approvalRequired ? 'approval-required' : status, code: exitCode});
    }

    function stop(status) {
      if (outcome || finished) return;
      outcome = status;
      clearTimeout(startupTimer);
      clearTimeout(taskTimer);
      killTree(child).catch(() => {}).then(() => {
        if (finished) return;
        stopTimer = setTimeout(() => {
          // A descendant can keep inherited pipes open even after the CLI exits.
          child.stdout.destroy();
          child.stderr.destroy();
          const exited = child.exitCode !== null || child.signalCode !== null;
          finish(exited ? outcome : 'stop-failed', child.exitCode);
          if (!exited) child.unref();
        }, 2000);
      });
    }

    const cancel = () => stop('cancelled');
    const startupTimer = setTimeout(() => stop('startup-timeout'), startupMs);
    const taskTimer = setTimeout(() => stop('timeout'), timeoutMs);
    signal?.addEventListener('abort', cancel, {once: true});

    for (const stream of [child.stdout, child.stderr]) {
      const filter = new OutputFilter(queue);
      stream.on('data', chunk => {
        if (outcome || finished) return;
        const remaining = Math.max(0, maxBytes - bytes);
        filter.write(chunk.subarray(0, remaining));
        bytes += chunk.length;
        if (bytes > maxBytes) stop('output-limit');
      });
      stream.on('end', () => {
        if (!finished) filter.end();
      });
    }
    child.on('error', error => {
      if (!finished) queue(error.message + '\n');
    });
    child.on('close', code => finish(outcome || (code === 0 ? 'completed' : 'failed'), code));
  });
}

module.exports = {runCli, cliEnvironment};
