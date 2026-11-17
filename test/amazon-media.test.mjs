import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { amazonImageErrorCode, amazonImageFailureStage, amazonImageUrl, prepararImagemAmazon } from '../amazon-image.js';

const require = createRequire(import.meta.url);
const sharp = require(process.env.SHARP_TEST_MODULE || 'sharp');

const amazonUrl = 'https://m.media-amazon.com/images/I/test-product.jpg';

function imageResponse(bytes, { status = 200, contentType = 'image/jpeg', contentLength = bytes.length } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) {
      if (name.toLowerCase() === 'content-type') return contentType;
      if (name.toLowerCase() === 'content-length') return contentLength === null ? null : String(contentLength);
      return null;
    } },
    body: Readable.from([bytes])
  };
}

test('Amazon aceita somente URL HTTPS do CDN permitido', () => {
  assert.ok(amazonImageUrl(amazonUrl) instanceof URL);
  for (const url of [
    'http://m.media-amazon.com/images/a.jpg',
    'https://example.com/a.jpg',
    'https://m.media-amazon.com.evil.invalid/a.jpg',
    'https://user:pass@m.media-amazon.com/a.jpg'
  ]) assert.equal(amazonImageUrl(url), null, url);
});

test('Amazon envia o buffer JPEG original, validado sem conversão', async () => {
  const input = await sharp({
    create: { width: 800, height: 900, channels: 3, background: { r: 215, g: 35, b: 60 } }
  }).jpeg({ quality: 88 }).toBuffer();
  let requestedUrl;
  let requestOptions;
  const result = await prepararImagemAmazon(amazonUrl, async (url, options) => {
    requestedUrl = String(url);
    requestOptions = options;
    return imageResponse(input);
  }, sharp);
  assert.equal(requestedUrl, amazonUrl);
  assert.equal(requestOptions.redirect, 'error');
  assert.equal(requestOptions.headers.Accept, 'image/jpeg');
  assert.equal(result.mimetype, 'image/jpeg');
  assert.equal(result.width, 800);
  assert.equal(result.height, 900);
  assert.equal(result.bytes, input.length);
  assert.equal(result.sha256, crypto.createHash('sha256').update(input).digest('hex'));
  assert.equal(Buffer.compare(result.buffer, input), 0, 'payload conserva todos os bytes do JPEG de origem');
});

test('Amazon rejeita download incompleto, MIME incorreto e resolução de miniatura', async () => {
  const input = await sharp({
    create: { width: 800, height: 800, channels: 3, background: '#b03040' }
  }).jpeg().toBuffer();
  const truncated = input.subarray(0, input.length - 80);
  await assert.rejects(
    prepararImagemAmazon(amazonUrl, async () => imageResponse(truncated, { contentLength: input.length }), sharp),
    error => amazonImageErrorCode(error) === 'download_incompleto' && amazonImageFailureStage(error) === 'download'
  );
  await assert.rejects(
    prepararImagemAmazon(amazonUrl, async () => imageResponse(truncated, { contentLength: null }), sharp),
    error => amazonImageErrorCode(error) === 'integridade_imagem_falhou' && amazonImageFailureStage(error) === 'preparacao'
  );
  await assert.rejects(
    prepararImagemAmazon(amazonUrl, async () => imageResponse(input, { contentType: 'image/webp' }), sharp),
    error => amazonImageErrorCode(error) === 'mime_nao_suportado' && amazonImageFailureStage(error) === 'preparacao'
  );
  const thumbnail = await sharp({ create: { width: 320, height: 320, channels: 3, background: '#b03040' } }).jpeg().toBuffer();
  await assert.rejects(
    prepararImagemAmazon(amazonUrl, async () => imageResponse(thumbnail), sharp),
    error => amazonImageErrorCode(error) === 'resolucao_insuficiente_ou_invalida'
  );
});

test('download Amazon com erro HTTP, erro de rede ou bytes JPEG corrompidos falha', async () => {
  await assert.rejects(
    prepararImagemAmazon(amazonUrl, async () => imageResponse(Buffer.alloc(0), { status: 403 }), sharp),
    error => amazonImageErrorCode(error) === 'download_http_403'
  );
  await assert.rejects(
    prepararImagemAmazon(amazonUrl, async () => { throw new Error('redirect denied'); }, sharp),
    error => amazonImageErrorCode(error) === 'download_falhou'
  );
  await assert.rejects(
    prepararImagemAmazon(amazonUrl, async () => imageResponse(Buffer.from('not an image'.repeat(1000))), sharp),
    error => amazonImageErrorCode(error) === 'integridade_imagem_falhou'
  );
});

async function serverFixture({ fetchImage, sendMessage } = {}) {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const executable = source.replace(/^import[\s\S]*?;\r?\n/gm, '');
  const files = new Map();
  const sent = [];
  const logs = [];
  let handler;
  let socket;
  const fetchStub = fetchImage || (async () => { throw new Error('Network is disabled in this test'); });
  const disk = {
    mkdirSync() {},
    existsSync: path => files.has(path),
    readFileSync(path) { if (!files.has(path)) throw new Error('ENOENT'); return files.get(path); },
    writeFileSync(path, value) { files.set(path, String(value)); },
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); }
  };
  const sandbox = {
    http: { createServer(fn) { handler = fn; return { listen() {} }; } },
    fs: disk,
    crypto,
    process: { env: { SEND_KEY: 'test-send-key', PORT: '0' } },
    Buffer, URL, URLSearchParams, AbortSignal,
    console: { log() {}, info(...args) { logs.push(args); }, warn(...args) { logs.push(args); }, error(...args) { logs.push(args); } },
    setTimeout, clearTimeout, setInterval() {},
    pino: () => ({}),
    Browsers: { ubuntu: name => ['Ubuntu', name, 'test'] },
    DisconnectReason: { loggedOut: 401, restartRequired: 515 },
    async useMultiFileAuthState() {
      return { state: { creds: { registered: true }, keys: {} }, async saveCreds() {} };
    },
    makeWASocket() {
      socket = {
        ev: new EventEmitter(),
        async sendMessage(jid, payload) {
          sent.push({ jid, payload });
          return sendMessage ? sendMessage(jid, payload) : { key: { id: 'mock-message-id' } };
        }
      };
      return socket;
    },
    fetch(url, options) {
      return fetchStub(url, options);
    },
    prepararImagemAmazon: (url) => prepararImagemAmazon(url, fetchStub, sharp),
    amazonImageErrorCode,
    amazonImageFailureStage
  };
  const api = await vm.runInNewContext(`(async () => { ${executable}\nreturn { enviarOfertaWhatsApp }; })()`, sandbox);
  socket.ev.emit('connection.update', { connection: 'open' });

  async function request(path, body) {
    const request = Readable.from([Buffer.from(JSON.stringify(body))]);
    request.method = 'POST'; request.url = path;
    request.headers = { host: 'localhost', 'content-type': 'application/json', 'x-send-key': 'test-send-key' };
    const response = {
      headers: {}, code: 200, body: '',
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      writeHead(code, headers = {}) { this.code = code; for (const [name, value] of Object.entries(headers)) this.setHeader(name, value); },
      end(value = '') { this.body = value; }
    };
    await handler(request, response);
    response.json = JSON.parse(response.body);
    return response;
  }
  return { request, sent, logs, sendOffer: api.enviarOfertaWhatsApp };
}

test('/send passes original buffer and caption together and marks recipient download unconfirmed', async () => {
  const input = await sharp({ create: { width: 800, height: 900, channels: 3, background: '#c02030' } }).jpeg().toBuffer();
  const fixture = await serverFixture({ fetchImage: async () => imageResponse(input) });
  const result = await fixture.request('/send', {
    marketplace: 'amazon', destino: '123@g.us', tipo: 'grupo', mensagem: 'Black Friday + cupom', imagem: amazonUrl
  });
  assert.equal(result.code, 200);
  assert.equal(result.json.imagemEnviada, true);
  assert.equal(result.json.midiaAceitaPeloBaileys, true);
  assert.equal(result.json.downloadDestinatarioConfirmado, null);
  assert.equal(result.json.statusMidia, 'aceita_pelo_baileys_download_nao_confirmado');
  assert.equal(result.json.fallbackTexto, false);
  assert.equal(result.json.tipoEnvio, 'imagem');
  assert.equal(fixture.sent.length, 1);
  assert.equal(fixture.sent[0].payload.caption, 'Black Friday + cupom');
  assert.ok(Buffer.isBuffer(fixture.sent[0].payload.image));
  assert.equal(fixture.sent[0].payload.mimetype, 'image/jpeg');
  assert.equal(Buffer.compare(fixture.sent[0].payload.image, input), 0);
});

test('/send distinguishes text fallback on download and media-send failures', async () => {
  const downloadFailure = await serverFixture({ fetchImage: async () => imageResponse(Buffer.alloc(0), { status: 503 }) });
  const downloadResponse = await downloadFailure.request('/send', {
    marketplace: 'amazon', destino: '123@g.us', tipo: 'grupo', mensagem: 'Oferta', imagem: amazonUrl
  });
  assert.equal(downloadResponse.json.imagemEnviada, false);
  assert.equal(downloadResponse.json.fallbackTexto, true);
  assert.equal(downloadResponse.json.tipoEnvio, 'texto_fallback');
  assert.deepEqual(JSON.parse(JSON.stringify(downloadFailure.sent[0].payload)), { text: 'Oferta' });
  assert.doesNotMatch(JSON.stringify(downloadFailure.logs), /m\.media-amazon\.com|test-product\.jpg/);

  const input = await sharp({ create: { width: 800, height: 900, channels: 3, background: '#c02030' } }).jpeg().toBuffer();
  const sendFailure = await serverFixture({
    fetchImage: async () => imageResponse(input),
    sendMessage: async (_jid, payload) => {
      if (payload.image) throw new Error('simulated media send failure');
      return { key: { id: 'text-only' } };
    }
  });
  const sendResponse = await sendFailure.request('/send', {
    marketplace: 'amazon', destino: '123@g.us', tipo: 'grupo', mensagem: 'Oferta', imagem: amazonUrl
  });
  assert.equal(sendResponse.json.imagemEnviada, false);
  assert.equal(sendResponse.json.fallbackTexto, true);
  assert.equal(sendResponse.json.tipoEnvio, 'texto_fallback');
  assert.equal(sendFailure.sent.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(sendFailure.sent[1].payload)), { text: 'Oferta' });
});

test('Amazon automatic offer uses the matching offer URL as a single image message; Mercado Livre remains URL-based', async () => {
  const input = await sharp({ create: { width: 800, height: 800, channels: 3, background: '#c02030' } }).jpeg().toBuffer();
  const fixture = await serverFixture({ fetchImage: async () => imageResponse(input) });
  const amazonOffer = { marketplace: 'amazon', titulo: 'Produto vinculado', imagem: amazonUrl, link: 'https://amzn.to/link' };
  await fixture.sendOffer(amazonOffer, '123@g.us', 'grupo');
  assert.equal(fixture.sent.length, 1);
  assert.equal(fixture.sent[0].payload.caption.includes('Produto vinculado'), true);
  assert.ok(Buffer.isBuffer(fixture.sent[0].payload.image));
  assert.equal(Buffer.compare(fixture.sent[0].payload.image, input), 0);

  const mercadoLivreOffer = { marketplace: 'mercadolivre', titulo: 'Item ML', imagem: 'https://http2.mlstatic.com/item.jpg' };
  await fixture.sendOffer(mercadoLivreOffer, '123@g.us', 'grupo');
  assert.equal(fixture.sent.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.sent[1].payload)), {
    image: { url: 'https://http2.mlstatic.com/item.jpg' }, caption: fixture.sent[1].payload.caption
  });
});
