// The Loop engine without VS Code: the retry policy, a run retried from the stage that failed, and the chat's helpers.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { askedOf, historyOf, templatesOf, tokensOf } from '../src/chat';
import { billionsOf, MAX_BILLIONS } from '../src/localModels';
import { backoff, DEFAULT_RETRY, defaultConfig, journalMarkdown, LoopEngine, newRun, nucFiles, parseSpecMarkdown, recoverRun, retryAfter, specMarkdown, specResources, toolEnv, transientStatus } from '../src/loopEngine';
import { checkConnections, readTrace } from '../src/loopSafety';

test('backoff grows exponentially, is capped and jittered, and honours Retry-After', () => {
  const top = () => 0.999999;
  assert.equal(backoff(1, DEFAULT_RETRY, undefined, top), 1000);
  assert.equal(backoff(3, DEFAULT_RETRY, undefined, top), 4000);
  assert.equal(backoff(10, DEFAULT_RETRY, undefined, top), 30000);
  assert.equal(backoff(3, DEFAULT_RETRY, undefined, () => 0), 0);
  assert.equal(backoff(1, DEFAULT_RETRY, 5000), 5000);
  assert.equal(backoff(1, DEFAULT_RETRY, 120000), 30000);
  assert.equal(retryAfter('2'), 2000);
  assert.equal(retryAfter(new Date(Date.now() + 3000).toUTCString(), Date.now()) ! > 1000, true);
  assert.equal(retryAfter('soon'), undefined);
  assert.ok(transientStatus(503) && transientStatus(429) && !transientStatus(422) && !transientStatus(404));
});

/** A fake Nuclear Developer: answers 503 to the first `failures` calls, then `answer`. */
function developer(failures: number, answer: object): Promise<{ url: string; calls: string[]; close: () => void }> {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url ?? '');
    if (calls.length <= failures) {
      res.writeHead(503).end('busy');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, calls, close: () => server.close() })));
}

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-'));
  fs.writeFileSync(path.join(root, 'config.nuc'), '');
  return root;
}

test('a passing failure of the local developer is retried, and each retry is in the trace', async () => {
  const dev = await developer(2, { report: 'done', trace: [] });
  const config = { ...defaultConfig('backend'), preflight: false, developerUrl: dev.url, retry: { attempts: 4, baseMs: 5, maxMs: 20 } };
  const engine = new LoopEngine(newRun(project(), { name: 'p', platform: 'backend', dialect: 'fastapi' }, spec()), config);
  const step = { id: 's', title: 's', actor: 'coder' as const, status: 'running' as const, summary: '', log: '', trace: [] as { step: string; detail: string }[] };
  const r = await (engine as unknown as { developer: (route: string, body: unknown, s: unknown) => Promise<{ ok: boolean }> }).developer('/developer/document', {}, step);
  dev.close();
  assert.ok(r.ok);
  assert.equal(dev.calls.length, 3);
  assert.equal(step.trace.filter((t) => t.step === 'retry').length, 2);
});

test('a failed run is retried from its failed stage: the stages before it are kept', async () => {
  const dev = await developer(0, { report: 'the run', trace: [] });
  const root = project();
  const config = { ...defaultConfig('backend'), preflight: false, developerUrl: dev.url, commands: { ...defaultConfig('backend').commands, build: ['true'], test: ['true'], artifacts: [], check: ['true'] } };
  const run = newRun(root, { name: 'p', platform: 'backend', dialect: 'fastapi' }, spec());
  for (const st of run.stages) st.status = ['spec', 'generate', 'plan', 'test', 'code'].includes(st.id) ? 'passed' : st.id === 'verify' ? 'failed' : 'skipped';
  run.stages[0].steps.push({ id: 'spec-1', title: 'Spec written', actor: 'you', status: 'passed', summary: 'kept', log: '', trace: [] });
  run.status = 'failed';
  const done = await new LoopEngine(run, config).start();
  dev.close();
  assert.equal(done.status, 'passed');
  assert.equal(done.stages[0].steps[0].summary, 'kept');
  assert.equal(done.previous?.length, 1);
  assert.equal(done.previous?.[0].from, 'verify');
  assert.match(journalMarkdown(done), /Retried from verify/);
});

test('the chat builds templates from the map and keeps the last messages', () => {
  const map = '## Component `books`\n\n- `x.nuc`\n  - usecase `AllBooks` — all\n';
  assert.ok(templatesOf(map, 'backend').some((t) => t.text.includes('`AllBooks`')));
  assert.equal(historyOf([{ role: 'you', text: 'hi', at: 0 }]), 'you: hi');
});

function spec() {
  return { id: 'books', title: 'Books', useCase: 'feature' as const, description: 'd', criteria: ['c'], context: [], source: { kind: 'local' as const }, lead: 'local' as const, pieces: [] };
}

test('a local model is measured by its effective size, against the 3B rule', () => {
  assert.equal(billionsOf('gemma4:e2b', '5.1B'), 2);
  assert.equal(billionsOf('qwen2.5-coder:3b', '3.1B'), 3.1);
  assert.ok(Math.abs(billionsOf('qwen2.5-coder:0.5b', '494.03M') - 0.494) < 0.001);
  assert.ok(billionsOf('qwen2.5-coder:7b', '7.6B') > MAX_BILLIONS && billionsOf('gemma4:e4b', '8.0B') > MAX_BILLIONS);
});

test('the pipeline finds the installed tools even when the editor was started without the shell PATH', () => {
  const env = toolEnv({ PATH: '/usr/bin:/bin' }, '/home/u', 'linux');
  assert.equal(env.PATH, '/usr/bin:/bin:/home/u/.local/bin:/home/u/.cargo/bin:/opt/homebrew/bin:/usr/local/bin');
  assert.match(toolEnv({ PATH: '/usr/bin', PREFIX: '/opt/n' }, '/home/u', 'linux').PATH!, /^\/usr\/bin:\/opt\/n\/bin:/);
  const win = toolEnv({ Path: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'C:\\Users\\u', 'win32');
  assert.ok(win.Path!.startsWith('C:\\Windows;') && win.Path!.includes('nuclearlang') && !('PATH' in win));
});

test('a retry goes on from the step that failed: a piece written before is not written again', async () => {
  const dev = await developer(0, { code: 'B\n  (n: int)\n', check: 'ok', attempts: 1, trace: [], report: 'r' });
  const root = project();
  fs.mkdirSync(path.join(root, 'a'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a', 'a.nuc'), 'A\n  (n: int)\n');
  const config = { ...defaultConfig('backend'), preflight: false, developerUrl: dev.url, commands: { ...defaultConfig('backend').commands, check: ['true'], build: ['true'], test: ['true'], artifacts: [] } };
  const run = newRun(root, { name: 'p', platform: 'backend', dialect: 'fastapi' }, { ...spec(), pieces: [{ path: 'a/a.nuc', kind: 'model', task: 'A' }, { path: 'a/b.nuc', kind: 'model', task: 'B' }] });
  for (const st of run.stages) st.status = ['spec', 'generate', 'plan', 'test'].includes(st.id) ? 'passed' : st.id === 'code' ? 'failed' : 'skipped';
  run.stages.find((st) => st.id === 'code')!.steps.push({ id: 'code-1', title: 'a/a.nuc', actor: 'coder', status: 'passed', summary: 'ok', log: 'ok', trace: [], file: 'a/a.nuc', code: 'A\n  (n: int)\n' });
  run.stages.find((st) => st.id === 'code')!.steps.push({ id: 'code-2', title: 'a/b.nuc', actor: 'coder', status: 'failed', summary: 'down', log: '', trace: [], file: 'a/b.nuc' });
  run.status = 'failed';
  const done = await new LoopEngine(run, config).start(undefined, true);
  dev.close();
  assert.equal(done.status, 'passed');
  assert.deepEqual(dev.calls.filter((c) => c === '/developer/code'), ['/developer/code']); // only b.nuc
  assert.equal(done.stages.find((st) => st.id === 'code')!.steps[0].title, 'a/a.nuc');
  assert.ok(fs.existsSync(path.join(root, 'a', 'b.nuc')));
});

test('the chat history goes newest first without repeats, and tokens are estimated from characters', () => {
  const s = (at: number, text: string) => ({ id: String(at), title: text, created: at, messages: [{ role: 'you' as const, text, at }] });
  assert.deepEqual(askedOf([s(1, 'a'), s(3, 'b'), s(2, 'a')]), ['b', 'a']);
  assert.equal(tokensOf(4000), 1000);
});

/** A fake service: `answer(url)` gives the status and body of each request; `hang` never answers. */
function service(answer: (url: string) => { status: number; body: unknown } | 'hang'): Promise<{ url: string; calls: string[]; close: () => void }> {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url ?? '');
    const a = answer(req.url ?? '');
    if (a === 'hang') return;
    res.writeHead(a.status, { 'content-type': 'application/json' }).end(JSON.stringify(a.body));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, calls, close: () => { server.closeAllConnections(); server.close(); } })));
}

test('a run left running by a process that stopped is recovered: its half-written file undone, then resumed', async () => {
  const dev = await developer(0, { code: 'B\n  (n: int)\n', check: 'ok', attempts: 1, trace: [], report: 'r' });
  const root = project();
  fs.mkdirSync(path.join(root, 'a'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a', 'a.nuc'), 'A\n  (n: int)\n');
  fs.writeFileSync(path.join(root, 'a', 'b.nuc'), 'half written');
  const run = newRun(root, { name: 'p', platform: 'backend', dialect: 'fastapi' }, { ...spec(), pieces: [{ path: 'a/a.nuc', kind: 'model', task: 'A' }, { path: 'a/b.nuc', kind: 'model', task: 'B' }] });
  for (const st of run.stages) st.status = ['spec', 'generate', 'plan', 'test'].includes(st.id) ? 'passed' : st.id === 'code' ? 'running' : 'pending';
  run.stages.find((st) => st.id === 'code')!.steps.push({ id: 'code-1', title: 'a/a.nuc', actor: 'coder', status: 'passed', summary: 'ok', log: 'ok', trace: [], file: 'a/a.nuc', code: 'A\n  (n: int)\n' });
  run.stages.find((st) => st.id === 'code')!.steps.push({ id: 'code-2', title: 'a/b.nuc', actor: 'coder', status: 'running', summary: '', log: '', trace: [], file: 'a/b.nuc' });
  run.writes = [{ path: 'a/a.nuc', step: 'code-1', before: null, at: 1 }, { path: 'a/b.nuc', step: 'code-2', before: null, at: 2 }];
  run.status = 'running';
  run.owner = { pid: 2 ** 22 + 7, host: os.hostname(), beat: Date.now() - 60_000 }; // a dead process, a stale beat
  assert.ok(recoverRun(run));
  assert.ok(!fs.existsSync(path.join(root, 'a', 'b.nuc')), 'the half-written file is undone');
  assert.ok(fs.existsSync(path.join(root, 'a', 'a.nuc')), 'what passed is kept');
  assert.equal(run.stages.find((st) => st.id === 'code')!.steps[1].status, 'failed');
  assert.match(run.interrupted![0].undone.join(), /a\/b\.nuc/);
  const config = { ...defaultConfig('backend'), preflight: false, developerUrl: dev.url, commands: { ...defaultConfig('backend').commands, check: ['true'], build: ['true'], test: ['true'], artifacts: [] } };
  const done = await new LoopEngine(run, config).start(undefined, true);
  dev.close();
  assert.equal(done.status, 'passed');
  assert.deepEqual(dev.calls.filter((c) => c === '/developer/code'), ['/developer/code']);
  const events = readTrace(path.join(root, '.nuclear', 'loop', 'runs', `${run.id}.log`)).map((e) => e.event);
  assert.ok(events.includes('recovered') && events.includes('resume') && events.includes('write'), events.join());
});

test('a call nothing works on is cut as stalled and retried', async () => {
  let hung = true;
  const dev = await service((url) => (url === '/docs' ? { status: 200, body: {} } : hung ? 'hang' : { status: 200, body: { report: 'done', trace: [] } }));
  const ollama = await service(() => ({ status: 200, body: { models: [] } }));
  const config = { ...defaultConfig('backend'), preflight: false, developerUrl: dev.url, ollamaUrl: ollama.url, stallSeconds: 0.6, retry: { attempts: 2, baseMs: 5, maxMs: 10 } };
  const engine = new LoopEngine(newRun(project(), { name: 'p', platform: 'backend', dialect: 'fastapi' }, spec()), config);
  const step = { id: 's', title: 's', actor: 'coder' as const, status: 'running' as const, summary: '', log: '', trace: [] as { step: string; detail: string }[] };
  setTimeout(() => (hung = false), 400); // the first call is cut at ~0.6 s; the retry finds it answering
  const r = await (engine as unknown as { developer: (route: string, body: unknown, s: unknown) => Promise<{ ok: boolean }> }).developer('/developer/document', {}, step);
  dev.close();
  ollama.close();
  assert.ok(r.ok);
  assert.ok(step.trace.some((t) => t.step === 'retry' && /stalled: Ollama/.test(t.detail)), JSON.stringify(step.trace));
});

test('the preflight tells each service that does not answer, a model not installed and a full disk', async () => {
  const ollama = await service(() => ({ status: 200, body: { models: [{ name: 'qwen2.5-coder:3b' }] } }));
  const checks = await checkConnections({ developerUrl: 'http://127.0.0.1:9', graphUrl: 'http://127.0.0.1:9', ollamaUrl: ollama.url, models: ['qwen2.5-coder:3b', 'gemma4:e2b'], tools: ['nuclear-missing-tool'], folders: [os.tmpdir()], minFreeMb: 1 });
  ollama.close();
  const bad = checks.filter((c) => !c.ok).map((c) => c.name);
  assert.deepEqual(bad.sort(), ['Nuclear Developer', 'Smart Graph', 'model gemma4:e2b', 'nuclear-missing-tool'].sort());
});

test('a command that hangs is killed after its limit and the step fails', async () => {
  const config = { ...defaultConfig('backend'), preflight: false, developerUrl: 'http://127.0.0.1:9', retry: { attempts: 1, baseMs: 1, maxMs: 1 }, commandTimeoutMs: 300, commands: { ...defaultConfig('backend').commands, artifacts: ['sleep 30'] } };
  const run = newRun(project(), { name: 'p', platform: 'backend', dialect: 'fastapi' }, spec());
  for (const st of run.stages) st.status = st.id === 'artifacts' ? 'failed' : st.id === 'deploy' ? 'pending' : 'passed';
  run.status = 'failed';
  const started = Date.now();
  const done = await new LoopEngine(run, config).start('artifacts');
  assert.ok(Date.now() - started < 5000, 'it did not wait for the command');
  const s = done.stages.find((x) => x.id === 'artifacts')!.steps.find((x) => x.title === 'sleep 30')!;
  assert.match(s.summary, /timed out/);
});

test('tests that inject a class the plan does not have stop the run at Tests first, saying so', async () => {
  const testCode = 'tests Characters\n  @test("lists")\n  lists() void\n    characters = inject<CharactersAppComponent>()\n    expect(true)\n';
  const dev = await developer(0, { code: testCode, check: 'ok', attempts: 1, trace: [], report: 'kind: spec' });
  const root = project();
  const config = { ...defaultConfig('backend'), preflight: false, developerUrl: dev.url, retry: { attempts: 1, baseMs: 1, maxMs: 1 } };
  const run = newRun(root, { name: 'p', platform: 'backend', dialect: 'fastapi' }, { ...spec(), pieces: [{ path: 'components/character/data/entities/character.nuc', kind: 'entity', task: 'entity Character. The spec says: ...' }] });
  for (const st of run.stages) st.status = ['spec', 'generate', 'plan'].includes(st.id) ? 'passed' : st.id === 'test' ? 'failed' : 'pending';
  run.status = 'failed';
  const done = await new LoopEngine(run, config).start('test');
  dev.close();
  const s = done.stages.find((x) => x.id === 'test')!.steps.find((x) => x.actor === 'tester')!;
  assert.equal(s.status, 'failed');
  assert.match(s.summary, /CharactersAppComponent, which is not in the plan \(the plan has 1 piece: entity Character\)/);
  assert.equal(done.stages.find((x) => x.id === 'code')!.status, 'skipped');
});

test('a spec names its resources: its Resources, else one per GET <url> line', () => {
  const spec = parseSpecMarkdown('# Characters\n\n## Description\n\nthe url:\n\nGET https://rickandmortyapi.com/api/character\n\nGET https://example.com/v1/categories\n\n## Acceptance criteria\n\n- [ ] lists\n', 'x');
  assert.deepEqual(specResources(spec, 'backend'), ['characters Character', 'categories Category']);
  assert.deepEqual(specResources(spec, 'mobile'), ['characters Character --screen characters', 'categories Category --screen categories']);
  spec.resources = ['catalog Book --fields "title:string" --source db'];
  const again = parseSpecMarkdown(specMarkdown(spec), 'x');
  assert.deepEqual(again.resources, ['catalog Book --fields "title:string" --source db']);
  assert.deepEqual(specResources(again, 'backend'), again.resources);
});

test('the files a generator changed are the difference of two snapshots, without the build output', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nuc-files-'));
  fs.mkdirSync(path.join(root, 'components', 'a'), { recursive: true });
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'components', 'a', 'x.nuc'), 'X');
  fs.writeFileSync(path.join(root, 'build', 'y.nuc'), 'Y');
  assert.deepEqual([...nucFiles(root).keys()], [path.join('components', 'a', 'x.nuc')]);
});
