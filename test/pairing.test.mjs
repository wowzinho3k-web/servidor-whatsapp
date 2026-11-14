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
  requestCode, saveFailure = false, writeFailure = false, key = 'test-secret', fetchShopee,
  shopeeEncryptionKey = 'a'.repeat(64), shopeeDeviceEnrollmentCode = 'simulated-personal-device-enrollment-code-1234567890' } = {}) {
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
    process: { env: {
      SEND_KEY: key,
      SHOPEE_CREDENTIALS_KEY: shopeeEncryptionKey,
      SHOPEE_BOOTSTRAP_TOKEN: 'simulated-bootstrap-invite',
      SHOPEE_DEVICE_ENROLLMENT_CODE: shopeeDeviceEnrollmentCode,
      SHOPEE_ACCOUNT_ADMIN_KEY: 'simulated-admin-key',
      SHOPEE_ALLOWED_ORIGINS: 'chrome-extension://test-extension'
    } },
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
    fetch(url, options) {
      if (fetchShopee) return fetchShopee(url, options);
      throw new Error('Network is forbidden in tests');
    }
  };
  await vm.runInNewContext(`(async () => { ${executable}\nreturn { processarDisparadorAutomatico, iniciarWhatsApp }; })()`, sandbox);
  async function request(path = '/pair', { method = 'GET', body, stream, auth = key, bearer, adminKey, origin,
    type = 'application/json' } = {}) {
    const req = Readable.from(stream || (body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]));
    req.method = method;
    req.url = path;
    req.headers = { host: 'localhost', 'content-type': type };
    if (auth !== null) req.headers['x-send-key'] = auth;
    if (bearer) req.headers.authorization = `Bearer ${bearer}`;
    if (adminKey) req.headers['x-shopee-admin-key'] = adminKey;
    if (origin) req.headers.origin = origin;
    req.socket = { remoteAddress: '127.0.0.1' };
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

test('contas Shopee usam autenticação real, credenciais criptografadas e isolamento por usuário', async () => {
  let respostaShopee = { data: { productOfferV2: { nodes: [], pageInfo: { page: 1, limit: 1, hasNextPage: false } } } };
  const chamadasShopee = [];
  const f = await fixture({ fetchShopee: async (url, options) => {
    chamadasShopee.push({ url, options });
    return { ok: true, status: 200, async text() { return JSON.stringify(respostaShopee); } };
  } });

  assert.equal((await f.request('/shopee/connection')).code, 401, 'SEND_KEY sozinha não autentica a conta Shopee');
  assert.equal((await f.request('/shopee/ofertas?quantidade=1')).code, 401);
  assert.equal((await f.request('/shopee/admin/invites', { method: 'POST', body: {} })).code, 401);

  const registro1 = await f.request('/shopee/auth/register', { method: 'POST', auth: null,
    body: { email: 'um@example.test', password: 'senha-forte-simulada-1', inviteCode: 'simulated-bootstrap-invite' } });
  assert.equal(registro1.code, 201);
  const sessao1 = registro1.json.token;
  assert.ok(sessao1);
  let armazenamento = f.files.get('/data/shopee-users.json');
  assert.ok(!armazenamento.includes('senha-forte-simulada-1'));
  assert.ok(!armazenamento.includes(sessao1));

  const convite = await f.request('/shopee/admin/invites', { method: 'POST', adminKey: 'simulated-admin-key', body: { email: 'dois@example.test' } });
  assert.equal(convite.code, 201);
  const registro2 = await f.request('/shopee/auth/register', { method: 'POST', auth: null,
    body: { email: 'dois@example.test', password: 'senha-forte-simulada-2', inviteCode: convite.json.inviteCode } });
  assert.equal(registro2.code, 201);
  const sessao2 = registro2.json.token;
  assert.equal((await f.request('/shopee/connection', { bearer: sessao2, origin: 'https://site-malicioso.example' })).headers['access-control-allow-origin'], undefined);

  respostaShopee = { errors: [{ message: 'Invalid Signature' }] };
  const falha = await f.request('/shopee/connection', { method: 'POST', bearer: sessao1,
    body: { appId: '111111', secret: 'secret-shopee-simulado-um' } });
  assert.equal(falha.code, 400);
  assert.equal(f.files.has('/data/shopee-credentials.json'), false, 'credenciais inválidas não são armazenadas');

  respostaShopee = { data: { productOfferV2: { nodes: [], pageInfo: { page: 1, limit: 1, hasNextPage: false } } } };
  const connect1 = await f.request('/shopee/connection', { method: 'POST', bearer: sessao1, origin: 'chrome-extension://test-extension',
    body: { appId: '111111', secret: 'secret-shopee-simulado-um' } });
  assert.equal(connect1.code, 200);
  assert.equal(connect1.json.connected, true);
  assert.equal(connect1.headers['access-control-allow-origin'], 'chrome-extension://test-extension');

  const connect2 = await f.request('/shopee/connection', { method: 'POST', bearer: sessao2,
    body: { appId: '222222', secret: 'secret-shopee-simulado-dois' } });
  assert.equal(connect2.code, 200);
  const credenciaisCriptografadas = f.files.get('/data/shopee-credentials.json');
  assert.ok(!credenciaisCriptografadas.includes('secret-shopee-simulado-um'));
  assert.ok(!credenciaisCriptografadas.includes('secret-shopee-simulado-dois'));

  const status2 = await f.request('/shopee/connection', { bearer: sessao2 });
  assert.equal(status2.json.connected, true);
  assert.equal(status2.json.appId, '••••2222');

  respostaShopee = { data: { productOfferV2: {
    nodes: [{ itemId: 87654321, productName: 'Fone Bluetooth autenticado', priceMin: 99.9, priceMax: 120,
      priceDiscountRate: 20, imageUrl: 'https://img.example/item.jpg', productLink: 'https://shopee.com.br/i.100.87654321',
      offerLink: 'https://shopee.com.br/universal-link-afiliado', shopName: 'Loja Simulada', sales: 500, ratingStar: 4.8, commissionRate: '0.1' }],
    pageInfo: { page: 1, limit: 20, hasNextPage: false }
  } } };
  const ofertas = await f.request('/shopee/ofertas?quantidade=1', { bearer: sessao1 });
  assert.equal(ofertas.code, 200);
  assert.equal(ofertas.json.total, 1);
  assert.equal(ofertas.json.ofertas[0].link, 'https://shopee.com.br/universal-link-afiliado');
  const chamada = chamadasShopee.at(-1);
  assert.equal(chamada.url, 'https://open-api.affiliate.shopee.com.br/graphql');
  const authHeader = chamada.options.headers.Authorization;
  const timestamp = authHeader.match(/Timestamp=(\d+)/)[1];
  const assinatura = crypto.createHash('sha256').update(`111111${timestamp}${chamada.options.body}secret-shopee-simulado-um`).digest('hex');
  assert.ok(authHeader.includes(`Signature=${assinatura}`), 'assinatura usa credencial do usuário autenticado');

  assert.equal((await f.request('/shopee/connection', { method: 'DELETE', bearer: sessao1 })).json.connected, false);
  assert.equal((await f.request('/shopee/connection', { bearer: sessao2 })).json.connected, true, 'desconectar uma conta não afeta outra');
  const logout = await f.request('/shopee/auth/logout', { method: 'POST', bearer: sessao2 });
  assert.equal(logout.code, 200);
  assert.equal((await f.request('/shopee/connection', { bearer: sessao2 })).code, 401);
});

test('ativação pessoal usa código de uso único e token duradouro sem identidade enviada pelo cliente', async () => {
  const f = await fixture({ fetchShopee: async () => ({ ok: true, status: 200, async text() {
    return JSON.stringify({ data: { productOfferV2: { nodes: [], pageInfo: { page: 1, limit: 1, hasNextPage: false } } } });
  } }) });
  const codigo = 'simulated-personal-device-enrollment-code-1234567890';
  assert.equal((await f.request('/shopee/device/enroll', { method: 'POST', auth: null, body: { code: 'wrong-code' } })).code, 401);
  const ativacao = await f.request('/shopee/device/enroll', { method: 'POST', auth: null,
    body: { code: codigo, userId: 'id-arbitrario-controlado-pelo-cliente' } });
  assert.equal(ativacao.code, 201);
  const token = ativacao.json.token;
  assert.ok(token);
  let usuarios = f.files.get('/data/shopee-users.json');
  assert.ok(!usuarios.includes(token), 'backend guarda só o hash do token');
  assert.ok(!usuarios.includes(codigo), 'código de ativação não é persistido');
  assert.ok(!usuarios.includes('id-arbitrario-controlado-pelo-cliente'), 'identidade vem do servidor');
  assert.equal(JSON.parse(usuarios).deviceEnrollmentUsed, true);
  assert.equal((await f.request('/shopee/connection', { bearer: token })).json.connected, false);
  f.advance(400 * 24 * 60 * 60 * 1000);
  assert.equal((await f.request('/shopee/connection', { bearer: token })).code, 200, 'token do dispositivo não expira em cada abertura');
  assert.equal((await f.request('/shopee/device/enroll', { method: 'POST', auth: null, body: { code: codigo } })).code, 409);
  const connected = await f.request('/shopee/connection', { method: 'POST', bearer: token,
    body: { appId: '555555', secret: 'simulated-personal-api-secret' } });
  assert.equal(connected.code, 200);
  const stored = f.files.get('/data/shopee-credentials.json');
  assert.ok(!stored.includes('simulated-personal-api-secret'), 'Secret Shopee permanece cifrado no backend');

  const novoCodigo = 'simulated-personal-device-enrollment-code-rotated-9876543210';
  const recuperacao = await fixture({ files: [...f.files.entries()], shopeeDeviceEnrollmentCode: novoCodigo });
  const novoDispositivo = await recuperacao.request('/shopee/device/enroll', { method: 'POST', auth: null, body: { code: novoCodigo } });
  assert.equal(novoDispositivo.code, 201, 'código rotacionado permite recuperar uma instalação reinstalada');
  assert.equal((await recuperacao.request('/shopee/connection', { bearer: token })).code, 401, 'token anterior é revogado ao reativar o dispositivo');
});

test('falha fechada se o backend não tiver chave de cifragem configurada', async () => {
  const f = await fixture({ shopeeEncryptionKey: '', fetchShopee: async () => {
    throw new Error('A API Shopee não deve ser chamada sem chave de cifragem.');
  } });
  const registro = await f.request('/shopee/auth/register', { method: 'POST', auth: null,
    body: { email: 'pessoal@example.test', password: 'senha-forte-simulada-3', inviteCode: 'simulated-bootstrap-invite' } });
  assert.equal(registro.code, 201);
  const response = await f.request('/shopee/connection', { method: 'POST', bearer: registro.json.token,
    body: { appId: '333333', secret: 'secret-shopee-simulado-tres' } });
  assert.equal(response.code, 503);
  assert.equal(f.files.has('/data/shopee-credentials.json'), false);
});

test('rotas originais e implementações das integrações permanecem preservadas', () => {
  const original = execFileSync('git', ['show', '492cfd7a23622c91abe16dddee9a3ed55e2634ff:server.js'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  const routes = s => [...s.matchAll(/caminho\s*===\s*"([^"]+)"/g)].map(m => m[1]);
  const rotasNaoShopee = s => routes(s).filter(p => p !== '/pair' && !p.startsWith('/shopee/')).sort();
  assert.deepEqual(rotasNaoShopee(source), rotasNaoShopee(original));
  const mercadoLivre = s => s.slice(s.indexOf('// MERCADO LIVRE - PKCE'), s.indexOf('// SHOPEE - ASSINATURA'));
  assert.equal(mercadoLivre(source), mercadoLivre(original));
  assert.ok(routes(source).includes('/shopee/ofertas'));
  const packageJson = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  assert.equal(packageJson.replace(/\r\n/g, '\n'), execFileSync('git', ['show', 'HEAD:package.json'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' }));
});
