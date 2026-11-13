// The set-up of the AI services (ADR-0106): what a machine is suggested, what a profile writes, and the files that
// start the services at login on each system.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { EMBEDDINGS, Hardware, PROFILES, REQUIREMENTS, fit, hasModel, launcher, machineOf, profileOf, readMachine, recommend, serviceFiles, steps, writeMachine } from '../src/aiSetup';

const machine = (ram: number, more: Partial<Hardware> = {}): Hardware => ({ platform: 'linux', arch: 'x64', cpu: 'test', cores: 8, ram, gpu: '', vram: 0, disk: 200, ...more });

test('the profiles go from nothing local to the heaviest, and each says how far it works', () => {
  assert.deepEqual(PROFILES.map((p) => p.id), ['remote', 'lite', 'medium', 'hard']);
  for (const p of PROFILES) {
    assert.ok(p.works.length && p.limits.length, `${p.id} says what works and what does not`);
    assert.equal(!!p.coder, p.id !== 'remote');
    if (p.coder) assert.ok(p.gb > 0 && p.minRam <= p.ram);
  }
  const sizes = PROFILES.map((p) => p.gb);
  assert.deepEqual(sizes, [...sizes].sort((a, b) => a - b));
});

test('the page of the set-up says of each profile what its data says', () => {
  const page = path.join(__dirname, '..', '..', '..', 'docs', 'ai', 'setup.md'); // only in the working tree
  if (!fs.existsSync(page)) return;
  const text = fs.readFileSync(page, 'utf8');
  for (const p of PROFILES.filter((x) => x.coder)) {
    for (const said of [`| \`${p.id}\` |`, `\`${p.coder}\``, `\`${p.assistant}\``, `| ${p.gb} GB |`, `${p.ram} GB (${p.minRam} GB at least)`, p.measured, ...p.works, ...p.limits]) {
      assert.ok(text.includes(said), `docs/ai/setup.md lacks, for ${p.id}: ${said}`);
    }
  }
});

test('a machine is suggested the heaviest profile that fits it, and the user may take another', () => {
  const [, lite, medium, hard] = PROFILES;
  assert.equal(recommend(machine(hard.ram)), 'hard');
  assert.equal(recommend(machine(medium.ram)), 'medium');
  assert.equal(recommend(machine(lite.ram)), 'lite');
  // too little for the lightest to run well: it is still the suggestion while its models load
  assert.equal(recommend(machine(lite.minRam)), 'lite');
  assert.equal(fit(lite, machine(lite.minRam)).fit, lite.minRam < lite.ram ? 'tight' : 'fits');
  // nothing local loads: only the remote agents
  assert.equal(recommend(machine(lite.minRam - 1)), 'remote');
  assert.equal(fit(hard, machine(lite.minRam - 1)).fit, 'no');
  // a full disk rules a profile out, whatever the memory
  assert.equal(fit(hard, machine(64, { disk: 3 })).fit, 'no');
  assert.match(fit(hard, machine(64, { disk: 3 })).note, /disk/);
  // a GPU that holds the models is said
  assert.match(fit(lite, machine(32, { gpu: 'RTX', vram: 24 })).note, /GPU \(RTX\)/);
});

test('the choice is kept in the machine file and read back', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nuclear-setup-')), 'nuclearlang', 'ai.env');
  const medium = profileOf('medium')!;
  writeMachine(machineOf(medium), file);
  assert.deepEqual(readMachine(file), { NUCLEAR_AI_MODE: 'local', NUCLEAR_AI_PROFILE: 'medium', CODER_MODEL: medium.coder, ASSISTANT_MODEL: medium.assistant, NUCLEAR_GRAPH_EMBED: EMBEDDINGS });
  // a later write keeps what it does not name
  writeMachine({ CODER_MODEL: 'other:1b' }, file);
  assert.equal(readMachine(file).CODER_MODEL, 'other:1b');
  assert.equal(readMachine(file).NUCLEAR_AI_PROFILE, 'medium');
  assert.deepEqual(machineOf(profileOf('remote')!), { NUCLEAR_AI_MODE: 'remote', NUCLEAR_AI_PROFILE: 'remote' });
  assert.deepEqual(readMachine(path.join(os.tmpdir(), 'no-such-file')), {});
});

test('each system gets the files that start the services at login', () => {
  const linux = serviceFiles('linux', '/home/u', '/home/u/.local/bin', '/home/u/.config/nuclearlang/ai.env', '/usr/bin');
  assert.deepEqual(linux.map((f) => f.path), ['/home/u/.config/systemd/user/nuclear-graph.service', '/home/u/.config/systemd/user/nuclear-developer.service']);
  assert.match(linux[0].text, /ExecStart=\/home\/u\/\.local\/bin\/nuclear-graph serve\n/);
  assert.match(linux[0].text, /EnvironmentFile=-\/home\/u\/\.config\/nuclearlang\/ai\.env/);
  assert.match(linux[1].text, /After=nuclear-graph\.service/);
  assert.match(linux[1].text, /WantedBy=default\.target/);
  const mac = serviceFiles('darwin', '/Users/u', '/Users/u/.local/bin', '/Users/u/.config/nuclearlang/ai.env', '/usr/bin');
  assert.equal(mac[0].path, '/Users/u/Library/LaunchAgents/io.github.nuclearlang.graph.plist');
  assert.match(mac[0].text, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(mac[1].text, /exec '\/Users\/u\/\.local\/bin\/nuclear-developer'/);
  const windows = serviceFiles('win32', 'C:\\Users\\u', 'C:\\n\\bin', 'C:\\Users\\u\\AppData\\Roaming\\nuclearlang\\ai.env', '');
  assert.equal(windows.length, 1);
  assert.match(windows[0].path, /Startup\\nuclear-ai\.cmd$/);
  assert.match(windows[0].text, /nuclear-graph\.exe" serve/);
  assert.match(windows[0].text, /nuclear-developer\.cmd"/);
  assert.deepEqual(serviceFiles('freebsd', '/home/u', '/b', '/m', ''), []);
  // a service runs with the tools' folders, not with the PATH of whoever ran the set-up
  assert.match(serviceFiles('linux', '/home/u', '/home/u/.local/bin', '/m')[0].text, /Environment=PATH=\/home\/u\/\.local\/bin:\/home\/u\/\.cargo\/bin:\/opt\/homebrew\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin\n/);
});

test('the launcher takes the machine models unless the caller gives its own', () => {
  const sh = launcher('/opt/ai', '/home/u/.config/nuclearlang/ai.env', 'linux');
  assert.equal(sh.name, 'nuclear-developer');
  assert.match(sh.text, /cd "\/opt\/ai\/nuclear-developer\/build" && exec \.venv\/bin\/uvicorn app\.main:app/);
  // run for real: a value of the file fills what is unset, a value of the caller stays
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuclear-launcher-'));
  const env = path.join(dir, 'ai.env');
  fs.writeFileSync(env, '# comment\nCODER_MODEL=from-file\nASSISTANT_MODEL=from-file\n');
  const script = launcher(dir, env, 'linux').text.replace(/^cd .*$/m, 'echo "$CODER_MODEL $ASSISTANT_MODEL"');
  fs.writeFileSync(path.join(dir, 'run.sh'), script);
  const out = require('node:child_process').execFileSync('sh', [path.join(dir, 'run.sh')], { env: { PATH: process.env.PATH, CODER_MODEL: 'from-caller' } });
  assert.equal(String(out).trim(), 'from-caller from-file');
  assert.equal(launcher('C:\\ai', 'C:\\m\\ai.env', 'win32').name, 'nuclear-developer.cmd');
});

test('a profile is installed in its steps, and remote agents alone take two', () => {
  assert.deepEqual(steps(profileOf('remote')!, '/opt/ai').map((s) => s.id), ['graph', 'machine']);
  assert.deepEqual(steps(profileOf('lite')!, '/opt/ai').map((s) => s.id), ['graph', 'developer', 'models', 'graph-service', 'knowledge', 'developer-service']);
  assert.match(steps(profileOf('hard')!, '/opt/ai')[2].title, new RegExp(EMBEDDINGS));
});

test('every requirement can be installed on the three systems or by hand', () => {
  assert.deepEqual(REQUIREMENTS.map((r) => r.id), ['nuclearlang', 'uv', 'ollama']);
  for (const r of REQUIREMENTS) {
    assert.match(r.url, /^https:\/\//);
    for (const system of ['linux', 'darwin', 'win32']) assert.ok(r.install[system], `${r.id} on ${system}`);
  }
  assert.equal(REQUIREMENTS.find((r) => r.id === 'ollama')!.local, true);
  assert.ok(hasModel(['embeddinggemma:latest'], 'embeddinggemma') && hasModel(['a:3b'], 'a:3b') && !hasModel(['a:3b'], 'a'));
});
