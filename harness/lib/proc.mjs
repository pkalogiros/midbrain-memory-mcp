// Child-process helpers: spawn with a hard timeout, optional stdin, optional
// NDJSON line callback, and optional raw stdout capture to a file.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';

export function spawnCapture(cmd, args, {
  cwd,
  env,
  timeoutMs = 120000,
  input = '',
  stdoutFile = null,
  onStdoutLine = null,
  signal = null,
} = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let buf = '';
    const out = stdoutFile ? createWriteStream(stdoutFile) : null;
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      if (out) out.end();
      resolve({ code: -1, signal: null, stdout, stderr: `[spawn error] ${err.message}`, timedOut, durationMs: 0, error: err.message });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      const hard = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 5000);
      if (typeof hard.unref === 'function') hard.unref();
    }, timeoutMs);
    const abort = () => { try { child.kill('SIGTERM'); } catch { /* already gone */ } };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const flushLines = (final = false) => {
      if (!onStdoutLine) return;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) onStdoutLine(line);
      }
      if (final && buf.trim()) {
        onStdoutLine(buf);
        buf = '';
      }
    };
    child.stdout.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      stdout += s;
      if (out) out.write(s);
      buf += s;
      flushLines(false);
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (out) out.end();
      resolve({ code: -1, signal: null, stdout, stderr: `${stderr}\n[spawn error] ${err.message}`, timedOut, durationMs: Date.now() - started, error: err.message });
    });
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      flushLines(true);
      if (out) out.end();
      resolve({ code, signal: exitSignal, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

export function whichSync(cmd, env = process.env) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { env, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.split(/\r?\n/)[0].trim() || null;
}

export function runSync(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
