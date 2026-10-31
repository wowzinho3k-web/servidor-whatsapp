import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import vm from 'node:vm';
import crypto from 'node:crypto';

// Executa o servidor inteiro com disco, HTTP, relógio e Baileys em memória.
// Não importa Baileys, não abre portas e não acessa rede nem /data real.
const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const executable = source.replace(/^import [\s\S]*?;\r?\n/gm, '');
const controlFile = '/data/whatsapp-connection.json';
const queueFile = '/data/fila-ofertas.json';
const configFile = '/data/disparador-config.json';
const legacyDir = '/data/baileys-auth';
const phone = '5592999999999';
const flush = async () => {
  // Streams usam nextTick além de microtasks; não avançamos o relógio simulado.
  await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
const close = (socket, code) => socket.ev.emit('connection.update', {
  connection: 'close', lastDisconnect: { error: { output: { statusCode: code } } }
});

async function fixture({ registered = false, files: initialFiles, autoReady = true,
  requestCode, saveFailure = false, writeFailure = false, key = 'test-secret' } = {}) {
  const files = new Map(initialFiles || [
    [legacyDir + '/creds.json', JSON.stringify({ registered })],
    [legacyDir + '/session-keep.json', 'preservar esta sessão'],
    [queueFile, JSON.stringify([{ fila_id: 'original', status: 'pendente', titulo: 'Oferta', link: 'https://example.invalid', preco: '10' }])],
    [configFile, JSON.stringify({ ativo: true, pausado: false, finalizado: false, destino: '123@g.us', tipo: 'grupo', intervalo_segundos: 600, total: 1, enviados: 0 })]
  ]);
  const writes = [];
  const sockets = [];
  const timers = new Set();
  const intervals = [];
  let handler;
  let now = 1000000;
  let messages = 0;
  let authCalls = 0;
  const disk = {
    mkdirSync() {},
    existsSync: p => files.has(p),
    readFileSync(p) { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
    writeFileSync(p, value) {
      if (writeFailure && p.startsWith(controlFile)) throw new Error('disk full');
      files.set(p, String(value)); writes.push(p);
    },
    renameSync(a, b) { files.set(b, files.get(a)); files.delete(a); writes.push(b); }
  };
  const sandbox = {
    fs: disk, crypto, Buffer, URL, URLSearchParams,
    process: { env: { SEND_KEY: key } },
    console: { log() {}, error() {} },
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    },
    setTimeout(fn, ms) { const t = { fn, ms }; timers.add(t); return t; },
    clearTimeout(t) { timers.delete(t); },
    setInterval(fn) { intervals.push(fn); },
    pino: () => ({}),
    Browsers: { ubuntu: name => ['Ubuntu', name, 'test'] },
    DisconnectReason: { loggedOut: 401, restartRequired: 515 },
    async useMultiFileAuthState(dir) {
      authCalls++;
      const state = { creds: files.has(dir + '/creds.json') ? JSON.parse(files.get(dir + '/creds.json')) : { registered: false }, keys: {} };
      return { state, async saveCreds() {
        if (saveFailure) throw new Error('save failed');
        disk.writeFileSync(dir + '/creds.json', JSON.stringify(state.creds));
      } };
    },
    makeWASocket(options) {
      const socket = {
        ev: new EventEmitter(), authState: options.auth, calls: [], ended: false,
        end() { socket.ended = true; close(socket, 428); },
        async requestPairingCode(number) {
          socket.calls.push(number);
          return requestCode ? requestCode(socket, number) : 'TESTCODE';
        },
        async sendMessage() { messages++; return { key: { id: 'simulated' } }; }
      };
      sockets.push(socket);
      if (autoReady) queueMicrotask(() => socket.ev.emit('connection.update', { connection: 'connecting', qr: 'SIMULATED-QR' }));
      return socket;
    },
    http: { createServer(fn) { handler = fn; return { listen() {} }; } },
    fetch() { throw new Error('Network is forbidden in tests'); }
  };
  await vm.runInNewContext(`(async () => { ${executable}\nreturn { processarDisparadorAutomatico, iniciarWhatsApp }; })()`, sandbox);
  async function request(path = '/pair', { method = 'GET', body, stream, auth = key,
    type = 'application/json' } = {}) {
    const req = Readable.from(stream || (body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]));
    req.method = method;
    req.url = path;
    req.headers = { host: 'localhost', 'content-type': type };
    if (auth !== null) req.headers['x-send-key'] = auth;
    const res = {
      headers: {}, code: 200, body: '',
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      writeHead(code, headers = {}) { this.code = code; for (const [k, v] of Object.entries(headers)) this.setHeader(k, v); },
      end(value = '') { this.body = value; }
    };
    await handler(req, res);
    if (res.headers['content-type']?.startsWith('application/json')) res.json = JSON.parse(res.body);
    return res;
  }
  return {
    files, writes, sockets, timers, request,
    get messages() { return messages; }, get authCalls() { return authCalls; },
    tick: async () => { for (const fn of intervals) await fn(); await flush(); },
    advance(ms) { now += ms; },
    async fire(ms) { for (const timer of [...timers]) if (timer.ms === ms) { timers.delete(timer); timer.fn(); } await flush(); },
    pair: () => request('/pair', { method: 'POST', body: { phone } }),
    async connect(socket = sockets.at(-1)) {
      socket.authState.creds.registered = true;
      socket.ev.emit('creds.update', {});
      await flush();
      socket.ev.emit('connection.update', { connection: 'open' });
    }
  };
}

test('chave incorreta/ausente e número inválido não criam sessão nem solicitam código', async () => {
  const f = await fixture();
  const before = [...f.files];
  for (const auth of [null, 'wrong']) {
    assert.equal((await f.request('/pair', { auth })).code, 401);
    assert.equal((await f.request('/pair', { method: 'POST', auth, body: { phone } })).code, 401);
  }
  for (const value of ['', '123', '0'.repeat(12), 'x' + phone, phone + '999999', {}, null]) {
    assert.equal((await f.request('/pair', { method: 'POST', body: { phone: value } })).code, 400);
  }
  assert.equal((await f.request('/pair', { method: 'POST', body: '{' })).code, 400);
  assert.equal((await f.request('/pair', { method: 'POST', body: 'x'.repeat(2100) })).code, 413);
  assert.equal((await f.request('/pair', { method: 'POST', body: phone, type: 'text/plain' })).code, 415);
  assert.deepEqual([...f.files], before);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.sockets[0].calls.length, 0);
});

test('deploy com sessão legada válida e fila ativa não retoma envios', async () => {
  const f = await fixture({ registered: true });
  const before = [...f.files];
  await f.connect();
  await f.tick();
  assert.equal(f.messages, 0);
  assert.equal((await f.request('/status')).json.retomada_manual_necessaria, true);
  assert.deepEqual([...f.files], before);
});

test('reinício também bloqueia retomada previamente liberada no metadado', async () => {
  const f = await fixture({ registered: true });
  f.files.set(controlFile, JSON.stringify({ authDir: legacyDir, invalidated: false, requiresManualResume: false }));
  const restarted = await fixture({ files: f.files });
  await restarted.connect();
  await restarted.tick();
  assert.equal(restarted.messages, 0);
  assert.equal((await restarted.request('/pair')).json.retomadaManualNecessaria, true);
});

test('SEND_KEY vazia mantém pareamento fechado', async () => {
  const f = await fixture({ key: '' });
  assert.equal((await f.pair()).code, 401);
});

test('formulário na página atual; código somente autenticado, sem cache nem vazamento em /status', async () => {
  const f = await fixture();
  const result = await f.request('/pair', { method: 'POST', body: 'phone=%2B55+(92)+99999-9999', type: 'application/x-www-form-urlencoded' });
  assert.equal(result.code, 200);
  assert.equal(result.json.pairingCode, 'TESTCODE');
  assert.equal(f.sockets.at(-1).calls[0], phone);
  assert.equal(result.headers['cache-control'], 'no-store');
  const page = await f.request('/');
  assert.match(page.body, /form id="pair-form"/);
  assert.match(page.body, /Gerar código/);
  assert.match(page.body, /Shopee:/);
  assert.match(page.body, /Fila:/);
  assert.match(page.body, /Disparador:/);
  assert.doesNotMatch(page.body, /TESTCODE|test-secret/);
  const script = page.body.match(/<script>([\s\S]*?)<\/script>/)[1];
  new vm.Script(script); // valida também o JavaScript entregue ao navegador
  const status = await f.request('/status');
  assert.doesNotMatch(status.body, /TESTCODE|test-secret/);
  assert.equal(status.json.retomada_manual_necessaria, true);
  assert.equal((await f.request('/pair', { auth: 'wrong' })).code, 401);
  assert.equal((await f.request('/pair')).json.pairingCode, 'TESTCODE');
});

test('aguarda QR, rejeita concorrência e não solicita código durante connecting', async () => {
  const f = await fixture({ autoReady: false });
  const first = f.pair();
  await flush();
  const socket = f.sockets.at(-1);
  assert.equal(f.sockets.length, 2);
  socket.ev.emit('connection.update', { connection: 'connecting' });
  await flush();
  assert.equal(socket.calls.length, 0);
  assert.equal((await f.pair()).code, 409);
  socket.ev.emit('connection.update', { qr: 'SIMULATED-QR' });
  assert.equal((await first).code, 200);
  assert.equal(socket.calls.length, 1);
  assert.equal((await f.pair()).code, 409); // código ainda disponível
});

test('401 preserva sessões e dados; pareamento cria pasta isolada e bloqueio persistente', async () => {
  const f = await fixture({ registered: true });
  const before = new Map(f.files);
  close(f.sockets[0], 401);
  assert.equal(f.timers.size, 0);
  assert.equal(JSON.parse(f.files.get(controlFile)).invalidated, true);
  const result = await f.pair();
  assert.equal(result.code, 200);
  const control = JSON.parse(f.files.get(controlFile));
  assert.match(control.authDir, /^\/data\/baileys-auth-pair-/);
  assert.equal(control.invalidated, false);
  assert.equal(control.requiresManualResume, true);
  await f.connect();
  await f.tick();
  assert.equal(f.messages, 0);
  for (const [path, value] of before) assert.equal(f.files.get(path), value, path);
  // Eventos atrasados do socket antigo não podem derrubar nem salvar sobre a sessão nova.
  f.sockets[0].ev.emit('connection.update', { connection: 'open' });
  close(f.sockets[0], 401);
  f.sockets[0].ev.emit('creds.update', {});
  await flush();
  assert.equal((await f.request('/pair')).json.conectado, true);
  assert.equal(JSON.parse(f.files.get(controlFile)).invalidated, false);
  const restarted = await fixture({ files: f.files });
  await restarted.connect();
  await restarted.tick();
  assert.equal(restarted.messages, 0);
  assert.equal((await restarted.request('/pair')).json.retomadaManualNecessaria, true);
});

test('reinício após 401 não tenta autenticar com credenciais invalidadas', async () => {
  const f = await fixture({ registered: true });
  close(f.sockets[0], 401);
  const restarted = await fixture({ files: f.files });
  assert.equal(restarted.authCalls, 0);
  assert.equal(restarted.sockets.length, 0);
  assert.match((await restarted.request('/pair')).json.status, /401\/loggedOut/);
  assert.equal((await restarted.pair()).code, 200);
});

test('515 aguarda salvar credenciais e reconecta com a mesma sessão; código é limpo', async () => {
  const f = await fixture();
  await f.pair();
  const selectedDir = JSON.parse(f.files.get(controlFile)).authDir;
  const paired = f.sockets.at(-1);
  paired.authState.creds.registered = true;
  paired.ev.emit('creds.update', {});
  close(paired, 515);
  await f.fire(1000);
  assert.equal(f.sockets.length, 3);
  assert.equal(f.sockets.at(-1).authState.creds.registered, true);
  assert.equal(JSON.parse(f.files.get(controlFile)).authDir, selectedDir);
  await f.connect();
  assert.equal((await f.request('/pair')).json.pairingCode, '');
  await f.tick();
  assert.equal(f.messages, 0);
});

test('desconexão transitória mantém a sessão registrada e não aceita troca por código', async () => {
  const f = await fixture({ registered: true });
  close(f.sockets[0], 408);
  assert.equal((await f.pair()).code, 409);
  await f.fire(5000);
  assert.equal(f.sockets.length, 2);
  assert.equal(f.sockets.at(-1).authState.creds.registered, true);
  assert.equal(f.files.has(controlFile), false);
});

test('timeout antes de QR encerra tentativa sem chamar requestPairingCode', async () => {
  const f = await fixture({ autoReady: false });
  const pending = f.pair();
  await flush();
  const socket = f.sockets.at(-1);
  await f.fire(30000);
  assert.equal((await pending).code, 504);
  assert.equal(socket.calls.length, 0);
  assert.equal(socket.ended, true);
  socket.ev.emit('connection.update', { qr: 'late' });
  assert.equal(socket.calls.length, 0);
});

test('401 enquanto aguarda QR encerra solicitação imediatamente e mantém sessão preservada', async () => {
  const f = await fixture({ autoReady: false });
  const legacyCreds = f.files.get(legacyDir + '/creds.json');
  const pending = f.pair();
  await flush();
  close(f.sockets.at(-1), 401);
  assert.equal((await pending).code, 409);
  assert.equal(f.sockets.at(-1).calls.length, 0);
  assert.equal(JSON.parse(f.files.get(controlFile)).invalidated, true);
  assert.equal(f.files.get(legacyDir + '/creds.json'), legacyCreds);
  assert.equal(f.timers.size, 0);
});

test('requestPairingCode pendente expira; conclusão tardia não publica código', async () => {
  let finish;
  const f = await fixture({ requestCode: () => new Promise(resolve => { finish = resolve; }) });
  const pending = f.pair();
  await flush();
  await f.fire(30000);
  assert.equal((await pending).code, 504);
  assert.equal(f.sockets.at(-1).ended, true);
  finish('LATECODE');
  await flush();
  assert.equal((await f.request('/pair')).json.pairingCode, '');
});

test('falha do Baileys não expõe detalhes nem permite eventos tardios', async () => {
  const f = await fixture({ requestCode: async () => { throw new Error('private internal detail'); } });
  const result = await f.pair();
  assert.equal(result.code, 502);
  assert.doesNotMatch(result.body, /private internal detail/);
  assert.equal(f.sockets.at(-1).ended, true);
  assert.equal(f.messages, 0);
});

test('código expira para consulta; nova tentativa conserva a pasta anterior', async () => {
  const f = await fixture();
  await f.pair();
  f.sockets.at(-1).ev.emit('creds.update', {});
  await flush();
  const previousDir = JSON.parse(f.files.get(controlFile)).authDir;
  const previousCreds = f.files.get(previousDir + '/creds.json');
  f.advance(60001);
  assert.equal((await f.request('/pair')).json.pairingCode, '');
  assert.equal((await f.pair()).code, 200);
  assert.notEqual(JSON.parse(f.files.get(controlFile)).authDir, previousDir);
  assert.equal(f.files.get(previousDir + '/creds.json'), previousCreds);
});

for (const path of ['/disparador/iniciar', '/disparador/continuar']) {
  test(`somente ação autenticada e conectada libera envios: ${path}`, async () => {
    const f = await fixture();
    await f.pair();
    assert.equal((await f.request(path, { method: 'POST', body: { destino: '123@g.us' } })).code, 500);
    assert.equal(JSON.parse(f.files.get(controlFile)).requiresManualResume, true);
    await f.connect();
    assert.equal((await f.request(path, { method: 'POST', auth: 'wrong', body: { destino: '123@g.us' } })).code, 401);
    await f.tick();
    assert.equal(f.messages, 0);
    assert.equal((await f.request(path, { method: 'POST', body: { destino: '123@g.us' } })).code, 200);
    assert.equal(JSON.parse(f.files.get(controlFile)).requiresManualResume, false);
    await f.tick();
    assert.equal(f.messages, 1); // Somente no simulador, nunca na rede.
  });
}

test('requisição antiga de iniciar não libera disparador após troca de sessão durante leitura do body', async () => {
  const f = await fixture({ registered: true });
  await f.connect();
  let release;
  const bodyReady = new Promise(resolve => { release = resolve; });
  const pendingStart = f.request('/disparador/iniciar', { method: 'POST', stream: (async function* () {
    await bodyReady;
    yield Buffer.from(JSON.stringify({ destino: '123@g.us' }));
  })() });
  await flush();
  close(f.sockets[0], 401);
  assert.equal((await f.pair()).code, 200);
  await f.connect();
  release();
  assert.equal((await pendingStart).code, 500);
  assert.equal(JSON.parse(f.files.get(controlFile)).requiresManualResume, true);
  await f.tick();
  assert.equal(f.messages, 0);
});

test('formulário envia chave pelo cabeçalho, renderiza com textContent e consulta sem gerar', async () => {
  const f = await fixture();
  const page = await f.request('/');
  const script = page.body.match(/<script>([\s\S]*?)<\/script>/)[1];
  const events = {};
  const elements = Object.fromEntries(['pair-form', 'pair-submit', 'pair-refresh', 'pair-key', 'pair-status', 'pair-code'].map(id => [id, {
    value: id === 'pair-key' ? 'ui-secret' : '',
    addEventListener(type, callback) { events[id + ':' + type] = callback; }
  }]));
  elements['pair-form'].elements = { phone: { value: phone } };
  const calls = [];
  const timers = [];
  vm.runInNewContext(script, {
    document: { getElementById: id => elements[id] },
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
    async fetch(path, options) {
      calls.push({ path, options });
      return { ok: true, async json() { return { status: 'Código gerado.', pairingCode: '<CODE>', expiraEm: Date.now() + 60000 }; } };
    }
  });
  let prevented = false;
  events['pair-form:submit']({ preventDefault() { prevented = true; } });
  await flush();
  assert.equal(prevented, true);
  assert.equal(calls[0].path, '/pair');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['x-send-key'], 'ui-secret');
  assert.equal(JSON.parse(calls[0].options.body).phone, phone);
  assert.equal(elements['pair-code'].textContent, '<CODE>');
  events['pair-refresh:click']();
  await flush();
  assert.equal(calls[1].options.method, 'GET');
  assert.equal(calls[1].options.body, undefined);
  timers.at(-1)();
  assert.equal(elements['pair-code'].textContent, '');
});

test('falha ao gravar controle impede geração e não modifica sessões, fila ou configuração', async () => {
  const f = await fixture({ writeFailure: true });
  const before = [...f.files];
  assert.equal((await f.pair()).code, 502);
  assert.equal(f.sockets.flatMap(s => s.calls).length, 0);
  assert.deepEqual([...f.files], before);
});

test('falha ao salvar credenciais fecha conexão e bloqueia disparador', async () => {
  const f = await fixture({ saveFailure: true });
  await f.pair();
  const socket = f.sockets.at(-1);
  socket.ev.emit('creds.update', {});
  await flush();
  socket.ev.emit('connection.update', { connection: 'open' });
  assert.equal((await f.request('/pair')).json.conectado, false);
  await f.tick();
  assert.equal(f.messages, 0);
});

test('metadado corrompido falha fechado sem selecionar outra sessão', async () => {
  await assert.rejects(fixture({ files: [[controlFile, '{']] }));
});

test('rotas originais e implementações das integrações permanecem preservadas', () => {
  const original = execFileSync('git', ['show', '492cfd7a23622c91abe16dddee9a3ed55e2634ff:server.js'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  const routes = s => [...s.matchAll(/caminho\s*===\s*"([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(routes(source).filter(p => p !== '/pair'), routes(original));
  const integrations = s => s.slice(s.indexOf('// MERCADO LIVRE - PKCE'), s.indexOf('// PROCESSAR DISPARADOR'));
  assert.equal(integrations(source), integrations(original));
  const packageJson = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  assert.equal(packageJson.replace(/\r\n/g, '\n'), execFileSync('git', ['show', 'HEAD:package.json'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' }));
});
