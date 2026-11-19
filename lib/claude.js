import { spawn, execFile } from 'node:child_process';

const children = new Set();

export function claudeAvailable() {
  return new Promise((resolve) => {
    execFile('claude', ['--version'], { timeout: 15000 }, (err, stdout) => {
      resolve(err ? { ok: false } : { ok: true, version: String(stdout).trim() });
    });
  });
}

export function killAll() {
  for (const c of children) c.kill('SIGTERM');
  children.clear();
}

export function askClaude({ prompt, schema, model, cwd, tools = [], timeoutMs = 240000, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('cancelled'));
    const args = [
      '-p', prompt,
      '--model', model,
      '--output-format', 'json',
      '--json-schema', JSON.stringify(schema),
      '--strict-mcp-config',
      '--no-session-persistence',
      '--setting-sources', 'project',
    ];
    if (tools.length) args.push('--allowedTools', ...tools);
    const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    const onAbort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      children.delete(child);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      children.delete(child);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('cancelled'));
      try {
        const res = JSON.parse(out);
        if (res.is_error) throw new Error(res.result || 'Claude returned an error');
        let data = res.structured_output;
        if (!data && typeof res.result === 'string') {
          const m = res.result.match(/\{[\s\S]*\}/);
          data = m ? JSON.parse(m[0]) : null;
        }
        if (!data) throw new Error('Empty reply');
        resolve(data);
      } catch (e) {
        reject(new Error(`claude exited ${code}: ${e.message} ${err.slice(0, 300)}`));
      }
    });
    return undefined;
  });
}
