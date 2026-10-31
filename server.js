import http from "http";
import fs from "fs";
import crypto from "crypto";

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  Browsers
} from "@whiskeysockets/baileys";

import pino from "pino";


// ======================================================
// CONFIGURAÇÕES GERAIS
// ======================================================

const PORT =
  process.env.PORT || 3000;

const AUTH_DIR =
  "/data/baileys-auth";

const WHATSAPP_CONNECTION_FILE = "/data/whatsapp-connection.json";
const PAIR_TIMEOUT_MS = 30000;
const PAIR_CODE_TTL_MS = 60000;

const SEND_KEY =
  process.env.SEND_KEY || "";


// ======================================================
// MERCADO LIVRE
// ======================================================

const ML_CLIENT_ID =
  process.env.ML_CLIENT_ID || "";

const ML_CLIENT_SECRET =
  process.env.ML_CLIENT_SECRET || "";

const ML_REDIRECT_URI =
  "https://noble-cedar-0445.de.deplexo.com/mercadolivre/callback";

const ML_TOKEN_FILE =
  "/data/mercadolivre-token.json";

const ML_OAUTH_FILE =
  "/data/mercadolivre-oauth.json";


// ======================================================
// SHOPEE
// ======================================================

const SHOPEE_APP_ID =
  process.env.SHOPEE_APP_ID || "";

const SHOPEE_SECRET =
  process.env.SHOPEE_SECRET || "";

const SHOPEE_ENDPOINT =
  "https://open-api.affiliate.shopee.com.br/graphql";


// ======================================================
// FILTRO SHOPEE
// ======================================================

const SHOPEE_PRECO_MINIMO = 15;

const SHOPEE_PRECO_MAXIMO = 1500;

const SHOPEE_DESCONTO_MINIMO = 10;

const SHOPEE_AVALIACAO_MINIMA = 4.4;

const SHOPEE_MULTIPLICADOR_CANDIDATOS = 5;

const SHOPEE_MAX_CANDIDATOS = 80;


// ======================================================
// FILA / DISPARADOR
// ======================================================

const FILA_FILE =
  "/data/fila-ofertas.json";

const DISPARADOR_FILE =
  "/data/disparador-config.json";

const INTERVALO_PADRAO_SEGUNDOS =
  600;


fs.mkdirSync(
  AUTH_DIR,
  {
    recursive: true
  }
);


// ======================================================
// ESTADO WHATSAPP
// ======================================================

let sock = null;

let conectado = false;

let status =
  "Servidor iniciado.";

// Apenas este arquivo novo seleciona a sessão; pastas antigas nunca são removidas.
let controleWhatsApp = carregarControleWhatsApp();
let contextoWhatsApp = null;
let iniciandoWhatsApp = null;
let reconexaoWhatsApp = null;
let pareandoWhatsApp = false;
let pairingCode = "";
let pairingCodeExpiraEm = 0;

function carregarControleWhatsApp() {
  if (!fs.existsSync(WHATSAPP_CONNECTION_FILE)) {
    return { authDir: AUTH_DIR, invalidated: false, requiresManualResume: true };
  }
  const dados = JSON.parse(fs.readFileSync(WHATSAPP_CONNECTION_FILE, "utf8"));
  if (!dados || typeof dados.authDir !== "string" ||
      !/^\/data\/baileys-auth(?:-pair-[a-f0-9-]{36})?$/.test(dados.authDir) ||
      typeof dados.invalidated !== "boolean" ||
      typeof dados.requiresManualResume !== "boolean") {
    throw new Error("Controle de sessão WhatsApp inválido. Preserve o arquivo para revisão.");
  }
  // Todo início de processo exige retomada explícita: deploy nunca retoma envios.
  return { ...dados, requiresManualResume: true };
}

function salvarControleWhatsApp(alteracoes) {
  const proximo = { ...controleWhatsApp, ...alteracoes };
  // Substituição atômica somente do metadado novo; não altera credenciais antigas.
  fs.writeFileSync(WHATSAPP_CONNECTION_FILE + ".tmp", JSON.stringify(proximo, null, 2), { mode: 0o600 });
  fs.renameSync(WHATSAPP_CONNECTION_FILE + ".tmp", WHATSAPP_CONNECTION_FILE);
  controleWhatsApp = proximo;
}

function limparCodigoWhatsApp() {
  pairingCode = "";
  pairingCodeExpiraEm = 0;
}

function erroPareamento(mensagem, statusCode = 409) {
  return Object.assign(new Error(mensagem), { statusCode });
}

function cancelarReconexaoWhatsApp() {
  clearTimeout(reconexaoWhatsApp);
  reconexaoWhatsApp = null;
}

async function encerrarSocketWhatsApp() {
  cancelarReconexaoWhatsApp();
  const anterior = contextoWhatsApp;
  contextoWhatsApp = null;
  sock = null;
  conectado = false;
  if (anterior) {
    anterior.closed = true;
    anterior.rejeitarEspera?.(erroPareamento("Conexão substituída."));
    anterior.socket.end(new Error("Preparando vinculação solicitada pelo operador."));
    await anterior.salvamento;
  }
}

async function aguardarSocketPareavel(ctx) {
  if (!ctx || ctx.closed || contextoWhatsApp !== ctx) throw erroPareamento("Conexão encerrada. Tente novamente.");
  if (ctx.state.creds.registered) throw erroPareamento("Sessão já registrada; aguarde a reconexão.");
  if (ctx.ready) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finalizar(erroPareamento("Tempo esgotado aguardando o WhatsApp.", 504)), PAIR_TIMEOUT_MS);
    function finalizar(erro) {
      clearTimeout(timer);
      ctx.resolverEspera = null;
      ctx.rejeitarEspera = null;
      erro ? reject(erro) : resolve();
    }
    ctx.resolverEspera = () => finalizar();
    ctx.rejeitarEspera = finalizar;
  });
}

async function gerarCodigoWhatsApp(telefone) {
  if (typeof telefone !== "string" || !/^\+?[\d\s().-]+$/.test(telefone.trim())) {
    throw erroPareamento("Número inválido. Use código do país + DDD + número.", 400);
  }
  const phone = telefone.replace(/\D/g, "");
  if (!/^[1-9]\d{9,14}$/.test(phone)) throw erroPareamento("Número inválido. Use código do país + DDD + número.", 400);
  if (pareandoWhatsApp) throw erroPareamento("Já existe uma solicitação em andamento.");
  if (conectado) throw erroPareamento("WhatsApp já conectado.");
  if (processandoDisparo) throw erroPareamento("Aguarde o envio em andamento terminar.");
  if (pairingCode && Date.now() < pairingCodeExpiraEm) {
    throw erroPareamento("Já há um código disponível. Consulte-o ou aguarde a expiração.");
  }
  pareandoWhatsApp = true;
  limparCodigoWhatsApp();
  try {
    await iniciandoWhatsApp;
    if (conectado) throw erroPareamento("WhatsApp já conectado.");
    const ctxAnterior = contextoWhatsApp;
    if (ctxAnterior?.state.creds.registered && !controleWhatsApp.invalidated) {
      throw erroPareamento("Sessão registrada em reconexão. Aguarde antes de vincular novamente.");
    }
    // O bloqueio sobrevive ao reinício e não modifica fila/configuração do disparador.
    salvarControleWhatsApp({ requiresManualResume: true });
    // Toda nova tentativa explícita usa credenciais e chaves novas, sem misturar sessões.
    await encerrarSocketWhatsApp();
    salvarControleWhatsApp({
      authDir: AUTH_DIR + "-pair-" + crypto.randomUUID(),
      invalidated: false
    });
    await iniciarWhatsApp();
    const ctx = contextoWhatsApp;
    await aguardarSocketPareavel(ctx);
    if (contextoWhatsApp !== ctx || ctx.closed || ctx.state.creds.registered) {
      throw erroPareamento("Conexão indisponível para pareamento.");
    }
    ctx.codeRequested = true;
    status = "Gerando código de conexão...";
    let timer;
    let code;
    try {
      code = await Promise.race([
        ctx.socket.requestPairingCode(phone),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(erroPareamento("Tempo esgotado gerando o código.", 504)), PAIR_TIMEOUT_MS);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (contextoWhatsApp !== ctx || ctx.closed || conectado) throw erroPareamento("A conexão mudou durante a solicitação.");
    pairingCode = String(code);
    pairingCodeExpiraEm = Date.now() + PAIR_CODE_TTL_MS;
    status = "Código gerado. Digite-o no WhatsApp do celular.";
  } catch (erro) {
    limparCodigoWhatsApp();
    if (!conectado) {
      status = controleWhatsApp.invalidated
        ? "Sessão encerrada (401/loggedOut). Solicite uma nova vinculação."
        : "Não foi possível gerar o código. Tente novamente.";
    }
    // Uma operação expirada não pode terminar depois e alterar o socket vigente.
    if (contextoWhatsApp && !conectado && !contextoWhatsApp.state.creds.registered) {
      await encerrarSocketWhatsApp();
    }
    throw erro.statusCode ? erro : erroPareamento("Falha ao gerar código de vinculação.", 502);
  } finally {
    pareandoWhatsApp = false;
  }
}

async function atenderPareamento(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!chaveValida(req)) {
    responderJSON(res, 401, { sucesso: false, erro: "Chave inválida." });
    return;
  }
  try {
    if (req.method === "POST") {
      const tipo = String(req.headers["content-type"] || "").split(";")[0].trim();
      if (tipo !== "application/json" && tipo !== "application/x-www-form-urlencoded") {
        throw erroPareamento("Formato de requisição inválido.", 415);
      }
      const partes = [];
      let tamanho = 0;
      for await (const parte of req) {
        tamanho += Buffer.byteLength(parte);
        if (tamanho > 2048) throw erroPareamento("Requisição muito grande.", 413);
        partes.push(Buffer.from(parte));
      }
      const body = Buffer.concat(partes).toString("utf8");
      let phone;
      try {
        phone = tipo === "application/json" ? JSON.parse(body)?.phone : new URLSearchParams(body).get("phone");
      } catch {
        throw erroPareamento("Requisição inválida.", 400);
      }
      await gerarCodigoWhatsApp(phone);
    }
    if (Date.now() >= pairingCodeExpiraEm) limparCodigoWhatsApp();
    responderJSON(res, 200, {
      sucesso: true, conectado, status, pairingCode,
      expiraEm: pairingCode ? pairingCodeExpiraEm : null,
      retomadaManualNecessaria: controleWhatsApp.requiresManualResume
    });
  } catch (erro) {
    responderJSON(res, erro.statusCode || 500, { sucesso: false, erro: erro.statusCode ? erro.message : "Falha ao preparar vinculação." });
  }
}

function formularioPareamento() {
  // A chave permanece apenas em memória na página; nunca é salva no navegador.
  return `
    <section style="max-width:520px;margin:24px auto">
      <h2>Vincular WhatsApp pelo telefone</h2>
      <form id="pair-form" method="POST" action="/pair">
        <p><label>Chave de acesso (SEND_KEY)<br><input id="pair-key" type="password" autocomplete="off" required></label></p>
        <p><label>Número com país e DDD<br><input name="phone" type="tel" placeholder="55 + DDD + número" autocomplete="off" required></label></p>
        <button id="pair-submit" type="submit">Gerar código</button>
        <button id="pair-refresh" type="button">Consultar código / conexão</button>
      </form>
      <p id="pair-status" role="status"></p>
      <output id="pair-code" style="font-size:32px;letter-spacing:4px"></output>
      <p>No celular: WhatsApp → Aparelhos conectados → Conectar um aparelho → Conectar com número de telefone.</p>
      <p>Após vincular, inicie ou continue o disparador explicitamente para liberar os envios.</p>
    </section>
    <script>
      (() => {
        const form = document.getElementById('pair-form');
        const button = document.getElementById('pair-submit');
        const output = document.getElementById('pair-code');
        const message = document.getElementById('pair-status');
        let expiryTimer;
        async function consultar(gerar) {
          button.disabled = true;
          output.textContent = '';
          clearTimeout(expiryTimer);
          message.textContent = gerar ? 'Preparando conexão e gerando código...' : 'Consultando conexão...';
          try {
            const key = document.getElementById('pair-key').value;
            const response = await fetch('/pair', {
              method: gerar ? 'POST' : 'GET',
              headers: { 'Content-Type': 'application/json', 'x-send-key': key },
              cache: 'no-store',
              ...(gerar ? { body: JSON.stringify({ phone: form.elements.phone.value }) } : {})
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.erro || 'Falha na solicitação.');
            message.textContent = data.status + (data.retomadaManualNecessaria ? ' Envios automáticos bloqueados até iniciar/continuar o disparador.' : '');
            output.textContent = data.pairingCode || '';
            if (data.pairingCode) expiryTimer = setTimeout(() => {
              output.textContent = '';
              message.textContent = 'Código ocultado por segurança. Consulte a conexão antes de solicitar outro.';
            }, Math.max(0, data.expiraEm - Date.now()));
          } catch (erro) {
            message.textContent = erro.message;
          } finally {
            button.disabled = false;
          }
        }
        form.addEventListener('submit', event => { event.preventDefault(); consultar(true); });
        document.getElementById('pair-refresh').addEventListener('click', () => consultar(false));
      })();
    </script>`;
}


// ======================================================
// CORS
// ======================================================

function aplicarCORS(res) {

  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, x-send-key"
  );
}


// ======================================================
// RESPOSTA JSON
// ======================================================

function responderJSON(
  res,
  statusCode,
  objeto
) {

  aplicarCORS(res);

  res.writeHead(
    statusCode,
    {
      "Content-Type":
        "application/json; charset=utf-8"
    }
  );

  res.end(
    JSON.stringify(
      objeto,
      null,
      2
    )
  );
}


// ======================================================
// SEGURANÇA
// ======================================================

function chaveValida(req) {

  const recebida =
    req.headers["x-send-key"];

  return (
    SEND_KEY &&
    recebida === SEND_KEY
  );
}


// ======================================================
// LER BODY JSON
// ======================================================

function lerBodyJSON(req) {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      let body = "";

      req.on(
        "data",
        chunk => {

          body +=
            chunk.toString();
        }
      );


      req.on(
        "end",
        () => {

          try {

            if (!body) {

              resolve({});

              return;
            }

            resolve(
              JSON.parse(body)
            );
          }

          catch {

            reject(
              new Error(
                "JSON inválido."
              )
            );
          }
        }
      );


      req.on(
        "error",
        reject
      );
    }
  );
}


// ======================================================
// ARQUIVOS JSON
// ======================================================

function salvarJSON(
  arquivo,
  dados
) {

  fs.writeFileSync(
    arquivo,
    JSON.stringify(
      dados,
      null,
      2
    ),
    "utf8"
  );
}


function lerJSON(arquivo) {

  try {

    if (
      !fs.existsSync(
        arquivo
      )
    ) {

      return null;
    }


    return JSON.parse(
      fs.readFileSync(
        arquivo,
        "utf8"
      )
    );
  }

  catch (erro) {

    console.error(
      "Erro lendo JSON:",
      erro
    );

    return null;
  }
}


// ======================================================
// FILA
// ======================================================

function carregarFila() {

  const fila =
    lerJSON(
      FILA_FILE
    );


  return Array.isArray(fila)
    ? fila
    : [];
}


function salvarFila(fila) {

  salvarJSON(
    FILA_FILE,
    fila
  );
}


function criarIdFila() {

  return crypto
    .randomBytes(12)
    .toString("hex");
}


function normalizarOferta(oferta) {

  const titulo =
    String(
      oferta?.titulo ||
      ""
    ).trim();


  const link =
    String(
      oferta?.link ||
      ""
    ).trim();


  if (
    !titulo ||
    !link
  ) {

    return null;
  }


  return {

    fila_id:
      criarIdFila(),

    marketplace:
      String(
        oferta.marketplace ||
        oferta.plataforma ||
        ""
      )
        .trim()
        .toLowerCase(),

    produto_id:
      oferta.id
        ? String(oferta.id)
        : null,

    titulo,

    link,

    imagem:
      oferta.imagem
        ? String(
            oferta.imagem
          ).trim()
        : null,

    preco:
      oferta.preco
        ? String(
            oferta.preco
          )
        : null,

    preco_numerico:
      Number(
        oferta.precoNumerico ||
        oferta.preco_numerico ||
        0
      ),

    preco_original:
      oferta.precoOriginalFormatado
        ? String(
            oferta.precoOriginalFormatado
          )
        : null,

    preco_original_numerico:
      Number(
        oferta.precoOriginalNumerico ||
        oferta.preco_original_numerico ||
        0
      ),

    status:
      "pendente",

    criado_em:
      new Date()
        .toISOString(),

    enviado_em:
      null,

    erro_envio:
      null
  };
}


// ======================================================
// FORMATAÇÃO
// ======================================================

function formatarNumeroBR(valor) {

  const numero =
    Number(valor);


  if (
    !Number.isFinite(numero)
  ) {

    return null;
  }


  return numero.toLocaleString(
    "pt-BR",
    {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }
  );
}


// ======================================================
// WHATSAPP
// ======================================================

async function iniciarWhatsApp() {
  if (iniciandoWhatsApp) return iniciandoWhatsApp;
  iniciandoWhatsApp = (async () => {
    if (controleWhatsApp.invalidated) {
      status = "Sessão encerrada (401/loggedOut). Solicite uma nova vinculação.";
      return;
    }
    if (contextoWhatsApp && !contextoWhatsApp.closed) return;
    cancelarReconexaoWhatsApp();
    const authDir = controleWhatsApp.authDir;
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const socket = makeWASocket({
      auth: state,
      logger: pino({ level: "silent" }),
      browser: Browsers.ubuntu("Chrome"),
      syncFullHistory: false,
      markOnlineOnConnect: false
    });
    const ctx = { socket, state, authDir, closed: false, ready: false,
      codeRequested: false, salvamento: Promise.resolve() };
    contextoWhatsApp = ctx;
    sock = socket;
    conectado = false;
    status = state.creds.registered ? "Reconectando WhatsApp..." : "Informe seu número para gerar o código.";

    socket.ev.on("creds.update", () => {
      if (contextoWhatsApp !== ctx || ctx.closed) return;
      ctx.salvamento = ctx.salvamento.then(saveCreds).catch(() => {
        status = "Não foi possível salvar a sessão WhatsApp. Verifique o armazenamento.";
        conectado = false;
        controleWhatsApp.requiresManualResume = true;
        console.error("Falha ao persistir credenciais WhatsApp.");
        ctx.closed = true;
        ctx.rejeitarEspera?.(erroPareamento("Falha ao salvar a sessão."));
        socket.end(new Error("Falha ao persistir sessão."));
      });
    });

    socket.ev.on("connection.update", update => {
      if (contextoWhatsApp !== ctx || ctx.closed) return;
      const { connection, lastDisconnect, qr } = update;
      if (qr && !state.creds.registered) {
        // Esperar QR é mais conservador que apenas "connecting": transporte pronto.
        ctx.ready = true;
        ctx.resolverEspera?.();
      }
      if (connection === "open") {
        conectado = true;
        limparCodigoWhatsApp();
        status = "WhatsApp conectado.";
        console.log("WhatsApp conectado.");
      }
      if (connection !== "close") return;
      ctx.closed = true;
      conectado = false;
      sock = null;
      limparCodigoWhatsApp();
      const code = lastDisconnect?.error?.output?.statusCode;
      ctx.rejeitarEspera?.(erroPareamento("Conexão encerrada. Tente novamente."));
      console.log("WhatsApp desconectou:", code);
      cancelarReconexaoWhatsApp();
      if (code === DisconnectReason.loggedOut) {
        controleWhatsApp.invalidated = true;
        controleWhatsApp.requiresManualResume = true;
        status = "Sessão encerrada (401/loggedOut). Solicite uma nova vinculação.";
        try {
          salvarControleWhatsApp({ invalidated: true, requiresManualResume: true });
        } catch {
          console.error("Falha ao persistir estado loggedOut. Envios bloqueados nesta execução.");
        }
        return;
      }
      status = "WhatsApp desconectado. Aguardando reconexão.";
      // Após parear, 515 pede outro socket com AS MESMAS credenciais.
      if (state.creds.registered || code === DisconnectReason.restartRequired) {
        reconexaoWhatsApp = setTimeout(() => {
          reconexaoWhatsApp = null;
          if (contextoWhatsApp !== ctx || controleWhatsApp.invalidated) return;
          ctx.salvamento.then(() => iniciarWhatsApp()).catch(() => {
            status = "Falha ao reconectar WhatsApp. Tente novamente.";
            console.error("Falha ao reconectar WhatsApp.");
          });
        }, code === DisconnectReason.restartRequired ? 1000 : 5000);
      } else {
        status = "Conexão de vinculação encerrada. Solicite outro código.";
      }
    });
  })();
  try {
    return await iniciandoWhatsApp;
  } finally {
    iniciandoWhatsApp = null;
  }
}


// ======================================================
// MERCADO LIVRE - PKCE
// ======================================================

function base64URL(buffer) {

  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}


function criarPKCE() {

  const codeVerifier =
    base64URL(
      crypto.randomBytes(48)
    );


  const hash =
    crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest();


  const codeChallenge =
    base64URL(hash);


  return {
    codeVerifier,
    codeChallenge
  };
}


// ======================================================
// MERCADO LIVRE - TOKEN
// ======================================================

async function trocarCodePorToken(
  code,
  codeVerifier
) {

  const params =
    new URLSearchParams();


  params.set(
    "grant_type",
    "authorization_code"
  );

  params.set(
    "client_id",
    ML_CLIENT_ID
  );

  params.set(
    "client_secret",
    ML_CLIENT_SECRET
  );

  params.set(
    "code",
    code
  );

  params.set(
    "redirect_uri",
    ML_REDIRECT_URI
  );


  if (codeVerifier) {

    params.set(
      "code_verifier",
      codeVerifier
    );
  }


  const resposta =
    await fetch(
      "https://api.mercadolibre.com/oauth/token",
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded"
        },

        body:
          params
      }
    );


  const dados =
    await resposta.json();


  if (!resposta.ok) {

    throw new Error(
      dados?.message ||
      dados?.error ||
      "Erro ao obter token."
    );
  }


  const agora =
    Date.now();


  const token = {

    ...dados,

    criado_em:
      agora,

    expira_em:
      agora +
      (
        Number(
          dados.expires_in ||
          0
        ) *
        1000
      )
  };


  salvarJSON(
    ML_TOKEN_FILE,
    token
  );


  return token;
}


// ======================================================
// SHOPEE - ASSINATURA
// ======================================================

function criarAssinaturaShopee(
  payload
) {

  const timestamp =
    Math.floor(
      Date.now() /
      1000
    );


  const base =
    `${SHOPEE_APP_ID}${timestamp}${payload}${SHOPEE_SECRET}`;


  const signature =
    crypto
      .createHash("sha256")
      .update(
        base,
        "utf8"
      )
      .digest("hex");


  return {
    timestamp,
    signature
  };
}


// ======================================================
// SHOPEE - CONSULTA
// ======================================================

async function consultarShopee(
  query,
  variables = {}
) {

  if (!SHOPEE_APP_ID) {

    throw new Error(
      "SHOPEE_APP_ID não configurado."
    );
  }


  if (!SHOPEE_SECRET) {

    throw new Error(
      "SHOPEE_SECRET não configurado."
    );
  }


  const payload =
    JSON.stringify({
      query,
      variables
    });


  const {
    timestamp,
    signature
  } =
    criarAssinaturaShopee(
      payload
    );


  const authorization =
    `SHA256 Credential=${SHOPEE_APP_ID}, Timestamp=${timestamp}, Signature=${signature}`;


  const resposta =
    await fetch(
      SHOPEE_ENDPOINT,
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json",

          "Authorization":
            authorization
        },

        body:
          payload
      }
    );


  const texto =
    await resposta.text();


  let dados;


  try {

    dados =
      JSON.parse(texto);
  }

  catch {

    throw new Error(
      `Shopee respondeu HTTP ${resposta.status}, mas não retornou JSON.`
    );
  }


  if (!resposta.ok) {

    throw new Error(
      `Shopee HTTP ${resposta.status}: ${texto}`
    );
  }


  return dados;
}


// ======================================================
// QUERY SHOPEE
// ======================================================

const QUERY_PRODUTOS_SHOPEE =
  `
    query BuscarProdutos(
      $page: Int,
      $limit: Int
    ) {
      productOfferV2(
        page: $page,
        limit: $limit
      ) {
        nodes {
          itemId
          productName
          priceMin
          priceMax
          priceDiscountRate
          imageUrl
          productLink
          offerLink
          shopName
          sales
          ratingStar
          commissionRate
        }

        pageInfo {
          page
          limit
          hasNextPage
        }
      }
    }
  `;


// ======================================================
// SHOPEE - TESTE
// ======================================================

async function testarShopee() {

  const resposta =
    await consultarShopee(
      QUERY_PRODUTOS_SHOPEE,
      {
        page: 1,
        limit: 1
      }
    );


  if (
    resposta?.errors?.length
  ) {

    return {
      sucesso: false,
      errors:
        resposta.errors
    };
  }


  const produto =
    resposta
      ?.data
      ?.productOfferV2
      ?.nodes
      ?.[0] ||
    null;


  return {

    sucesso:
      true,

    autenticado:
      true,

    mensagem:
      "Shopee Affiliate API conectada.",

    produto_teste:
      produto
  };
}


// ======================================================
// TEXTO NORMALIZADO
// ======================================================

function normalizarTexto(texto) {

  return String(
    texto ||
    ""
  )
    .normalize("NFD")
    .replace(
      /[\u0300-\u036f]/g,
      ""
    )
    .toLowerCase()
    .replace(
      /[^a-z0-9\s]/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}


// ======================================================
// PALAVRAS PRODUTO
// ======================================================

const PALAVRAS_IGNORADAS =
  new Set([
    "para",
    "com",
    "sem",
    "kit",
    "novo",
    "nova",
    "original",
    "profissional",
    "premium",
    "unidade",
    "unidades",
    "cor",
    "cores",
    "modelo",
    "produto",
    "brasil",
    "envio",
    "rapido",
    "pronta",
    "entrega",
    "oficial",
    "loja",
    "masculino",
    "feminino"
  ]);


function palavrasProduto(titulo) {

  return normalizarTexto(titulo)
    .split(" ")
    .filter(
      palavra =>
        palavra.length >= 4 &&
        !PALAVRAS_IGNORADAS.has(
          palavra
        )
    );
}


// ======================================================
// SIMILARIDADE
// ======================================================

function similaridadeTitulos(
  tituloA,
  tituloB
) {

  const a =
    new Set(
      palavrasProduto(
        tituloA
      )
    );


  const b =
    new Set(
      palavrasProduto(
        tituloB
      )
    );


  if (
    a.size === 0 ||
    b.size === 0
  ) {

    return 0;
  }


  let iguais =
    0;


  for (
    const palavra of a
  ) {

    if (
      b.has(palavra)
    ) {

      iguais++;
    }
  }


  const uniao =
    new Set([
      ...a,
      ...b
    ]).size;


  return uniao > 0
    ? iguais / uniao
    : 0;
}


// ======================================================
// GRUPO PRODUTO
// ======================================================

function descobrirGrupoProduto(titulo) {

  const t =
    normalizarTexto(
      titulo
    );


  const grupos = [

    {
      nome:
        "filamento3d",

      palavras: [
        "filamento",
        "impressora 3d",
        "pla 1 75",
        "petg"
      ]
    },

    {
      nome:
        "tenis",

      palavras: [
        "tenis",
        "sapatilha",
        "calcado"
      ]
    },

    {
      nome:
        "celular",

      palavras: [
        "smartphone",
        "celular",
        "iphone",
        "galaxy"
      ]
    },

    {
      nome:
        "carregador",

      palavras: [
        "carregador",
        "power bank",
        "powerbank",
        "cabo usb"
      ]
    },

    {
      nome:
        "ferramentas",

      palavras: [
        "parafusadeira",
        "furadeira",
        "chave",
        "ferramenta",
        "serra",
        "esmerilhadeira"
      ]
    },

    {
      nome:
        "automotivo",

      palavras: [
        "automotivo",
        "carro",
        "pneu",
        "vonixx",
        "lavagem",
        "pretinho"
      ]
    },

    {
      nome:
        "cozinha",

      palavras: [
        "panela",
        "air fryer",
        "cafeteira",
        "liquidificador",
        "cozinha",
        "garrafa termica"
      ]
    },

    {
      nome:
        "audio",

      palavras: [
        "fone",
        "headset",
        "caixa de som",
        "bluetooth"
      ]
    },

    {
      nome:
        "informatica",

      palavras: [
        "mouse",
        "teclado",
        "ssd",
        "monitor",
        "computador",
        "notebook"
      ]
    },

    {
      nome:
        "pesca",

      palavras: [
        "pesca",
        "pescaria",
        "molinete",
        "carretilha",
        "vara"
      ]
    },

    {
      nome:
        "casa",

      palavras: [
        "organizador",
        "lixeira",
        "almofada",
        "travesseiro",
        "lampada",
        "luminaria"
      ]
    },

    {
      nome:
        "fitness",

      palavras: [
        "academia",
        "fitness",
        "whey",
        "creatina",
        "bicicleta ergometrica"
      ]
    }
  ];


  for (
    const grupo of grupos
  ) {

    if (
      grupo.palavras.some(
        palavra =>
          t.includes(
            palavra
          )
      )
    ) {

      return grupo.nome;
    }
  }


  return null;
}


// ======================================================
// PRODUTO INDESEJADO
// ======================================================

function produtoIndesejado(titulo) {

  const t =
    normalizarTexto(
      titulo
    );


  const bloqueados = [
    "geladeira",
    "refrigerador",
    "freezer",
    "guarda roupa",
    "roupeiro",
    "sofa",
    "colchao casal",
    "colchao queen",
    "colchao king",
    "cama box",
    "mesa jantar",
    "rack sala",
    "painel tv",
    "armario cozinha completo",
    "balcao cozinha completo"
  ];


  return bloqueados.some(
    termo =>
      t.includes(
        termo
      )
  );
}


// ======================================================
// COMISSÃO %
// ======================================================

function obterComissaoPercentual(valor) {

  const numero =
    Number(
      valor ||
      0
    );


  if (
    !Number.isFinite(
      numero
    )
  ) {

    return 0;
  }


  if (
    numero <= 1
  ) {

    return numero * 100;
  }


  return numero;
}


// ======================================================
// PREÇO ORIGINAL
// ======================================================

function calcularPrecoOriginal(
  precoAtual,
  desconto
) {

  const atual =
    Number(precoAtual);

  const percentual =
    Number(desconto);


  if (
    !Number.isFinite(atual) ||
    !Number.isFinite(percentual) ||
    atual <= 0 ||
    percentual <= 0 ||
    percentual >= 90
  ) {

    return 0;
  }


  const original =
    atual /
    (
      1 -
      percentual / 100
    );


  if (
    original <= atual
  ) {

    return 0;
  }


  return Number(
    original.toFixed(2)
  );
}


// ======================================================
// PONTUAÇÃO SHOPEE
// ======================================================

function calcularPontuacaoShopee(
  produto
) {

  const desconto =
    Math.max(
      0,
      Math.min(
        80,
        Number(
          produto.desconto ||
          0
        )
      )
    );


  const vendas =
    Math.max(
      0,
      Number(
        produto.vendas ||
        0
      )
    );


  const avaliacao =
    Math.max(
      0,
      Math.min(
        5,
        Number(
          produto.avaliacao ||
          0
        )
      )
    );


  const comissao =
    Math.max(
      0,
      Math.min(
        40,
        Number(
          produto.comissaoPercentual ||
          0
        )
      )
    );


  const preco =
    Number(
      produto.precoNumerico ||
      0
    );


  let pontos =
    desconto * 1.4;


  pontos +=
    Math.log10(
      vendas + 1
    ) *
    14;


  pontos +=
    avaliacao * 8;


  pontos +=
    comissao * 0.7;


  if (
    preco >= 25 &&
    preco <= 200
  ) {

    pontos += 18;
  }

  else if (
    preco > 200 &&
    preco <= 500
  ) {

    pontos += 10;
  }

  else if (
    preco > 500 &&
    preco <= 1000
  ) {

    pontos += 3;
  }


  return Number(
    pontos.toFixed(2)
  );
}


// ======================================================
// NORMALIZAR PRODUTO SHOPEE
// ======================================================

function normalizarProdutoShopee(
  produto
) {

  if (!produto) {

    return null;
  }


  const titulo =
    String(
      produto.productName ||
      ""
    ).trim();


  const link =
    String(
      produto.offerLink ||
      produto.productLink ||
      ""
    ).trim();


  const precoNumerico =
    Number(
      produto.priceMin ||
      produto.priceMax ||
      0
    );


  const desconto =
    Number(
      produto.priceDiscountRate ||
      0
    );


  const vendas =
    Number(
      produto.sales ||
      0
    );


  const avaliacao =
    Number(
      produto.ratingStar ||
      0
    );


  const comissaoPercentual =
    obterComissaoPercentual(
      produto.commissionRate
    );


  if (
    !titulo ||
    !link ||
    !Number.isFinite(
      precoNumerico
    ) ||
    precoNumerico <= 0
  ) {

    return null;
  }


  const precoOriginalNumerico =
    calcularPrecoOriginal(
      precoNumerico,
      desconto
    );


  const oferta = {

    plataforma:
      "SHOPEE",

    marketplace:
      "shopee",

    id:
      produto.itemId
        ? String(
            produto.itemId
          )
        : null,

    titulo,

    preco:
      formatarNumeroBR(
        precoNumerico
      ),

    precoNumerico,

    precoOriginalFormatado:
      precoOriginalNumerico >
        precoNumerico
        ? formatarNumeroBR(
            precoOriginalNumerico
          )
        : null,

    precoOriginalNumerico,

    desconto,

    loja:
      produto.shopName ||
      null,

    vendas,

    avaliacao,

    comissao:
      produto.commissionRate ||
      null,

    comissaoPercentual,

    imagem:
      produto.imageUrl ||
      null,

    link,

    grupo:
      descobrirGrupoProduto(
        titulo
      )
  };


  oferta.pontuacao =
    calcularPontuacaoShopee(
      oferta
    );


  return oferta;
}


// ======================================================
// BUSCAR CANDIDATOS SHOPEE
// ======================================================

async function buscarCandidatosShopee(
  quantidadeDesejada
) {

  const alvo =
    Math.min(
      SHOPEE_MAX_CANDIDATOS,
      Math.max(
        30,
        quantidadeDesejada *
        SHOPEE_MULTIPLICADOR_CANDIDATOS
      )
    );


  const candidatos = [];

  const ids =
    new Set();

  const POR_PAGINA = 20;

  let pagina = 1;

  let temProxima = true;


  while (
    candidatos.length < alvo &&
    pagina <= 5 &&
    temProxima
  ) {

    const resposta =
      await consultarShopee(
        QUERY_PRODUTOS_SHOPEE,
        {
          page:
            pagina,

          limit:
            POR_PAGINA
        }
      );


    if (
      resposta?.errors?.length
    ) {

      throw new Error(
        JSON.stringify(
          resposta.errors
        )
      );
    }


    const bloco =
      resposta
        ?.data
        ?.productOfferV2;


    const produtos =
      bloco?.nodes;


    if (
      !Array.isArray(
        produtos
      ) ||
      produtos.length === 0
    ) {

      break;
    }


    for (
      const bruto of produtos
    ) {

      const produto =
        normalizarProdutoShopee(
          bruto
        );


      if (!produto) {

        continue;
      }


      if (
        produto.id &&
        ids.has(
          produto.id
        )
      ) {

        continue;
      }


      if (produto.id) {

        ids.add(
          produto.id
        );
      }


      candidatos.push(
        produto
      );


      if (
        candidatos.length >= alvo
      ) {

        break;
      }
    }


    temProxima =
      bloco
        ?.pageInfo
        ?.hasNextPage !==
      false;


    pagina++;
  }


  return candidatos;
}


// ======================================================
// PRODUTO ACEITÁVEL
// ======================================================

function produtoAceitavel(
  produto,
  flexivel = false
) {

  if (!produto) {

    return false;
  }


  if (
    produtoIndesejado(
      produto.titulo
    )
  ) {

    return false;
  }


  if (
    produto.precoNumerico <
      SHOPEE_PRECO_MINIMO ||
    produto.precoNumerico >
      SHOPEE_PRECO_MAXIMO
  ) {

    return false;
  }


  if (!flexivel) {

    if (
      produto.desconto <
      SHOPEE_DESCONTO_MINIMO
    ) {

      return false;
    }


    if (
      produto.avaliacao > 0 &&
      produto.avaliacao <
        SHOPEE_AVALIACAO_MINIMA
    ) {

      return false;
    }
  }


  return true;
}


// ======================================================
// SIMILARIDADE
// ======================================================

function muitoParecido(
  candidato,
  selecionados
) {

  for (
    const escolhido of selecionados
  ) {

    const similaridade =
      similaridadeTitulos(
        candidato.titulo,
        escolhido.titulo
      );


    if (
      similaridade >= 0.42
    ) {

      return true;
    }
  }


  return false;
}


// ======================================================
// SELEÇÃO SHOPEE
// ======================================================

function selecionarMelhoresShopee(
  candidatos,
  quantidade
) {

  const ordenados =
    [
      ...candidatos
    ]
      .sort(
        (a, b) =>
          b.pontuacao -
          a.pontuacao
      );


  const selecionados = [];

  const gruposUsados =
    new Map();

  const ids =
    new Set();


  // Primeira passagem

  for (
    const produto of ordenados
  ) {

    if (
      selecionados.length >=
      quantidade
    ) {

      break;
    }


    if (
      !produtoAceitavel(
        produto,
        false
      )
    ) {

      continue;
    }


    if (
      produto.id &&
      ids.has(
        produto.id
      )
    ) {

      continue;
    }


    if (
      muitoParecido(
        produto,
        selecionados
      )
    ) {

      continue;
    }


    if (produto.grupo) {

      const usados =
        gruposUsados.get(
          produto.grupo
        ) || 0;


      if (
        usados >= 1
      ) {

        continue;
      }
    }


    selecionados.push(
      produto
    );


    if (produto.id) {

      ids.add(
        produto.id
      );
    }


    if (produto.grupo) {

      gruposUsados.set(
        produto.grupo,
        (
          gruposUsados.get(
            produto.grupo
          ) || 0
        ) + 1
      );
    }
  }


  // Segunda passagem

  if (
    selecionados.length <
    quantidade
  ) {

    for (
      const produto of ordenados
    ) {

      if (
        selecionados.length >=
        quantidade
      ) {

        break;
      }


      if (
        !produtoAceitavel(
          produto,
          false
        )
      ) {

        continue;
      }


      if (
        produto.id &&
        ids.has(
          produto.id
        )
      ) {

        continue;
      }


      if (
        muitoParecido(
          produto,
          selecionados
        )
      ) {

        continue;
      }


      if (produto.grupo) {

        const usados =
          gruposUsados.get(
            produto.grupo
          ) || 0;


        if (
          usados >= 2
        ) {

          continue;
        }
      }


      selecionados.push(
        produto
      );


      if (produto.id) {

        ids.add(
          produto.id
        );
      }


      if (produto.grupo) {

        gruposUsados.set(
          produto.grupo,
          (
            gruposUsados.get(
              produto.grupo
            ) || 0
          ) + 1
        );
      }
    }
  }


  // Terceira passagem

  if (
    selecionados.length <
    quantidade
  ) {

    for (
      const produto of ordenados
    ) {

      if (
        selecionados.length >=
        quantidade
      ) {

        break;
      }


      if (
        !produtoAceitavel(
          produto,
          true
        )
      ) {

        continue;
      }


      if (
        produto.id &&
        ids.has(
          produto.id
        )
      ) {

        continue;
      }


      if (
        muitoParecido(
          produto,
          selecionados
        )
      ) {

        continue;
      }


      selecionados.push(
        produto
      );


      if (produto.id) {

        ids.add(
          produto.id
        );
      }
    }
  }


  // Última passagem

  if (
    selecionados.length <
    quantidade
  ) {

    for (
      const produto of ordenados
    ) {

      if (
        selecionados.length >=
        quantidade
      ) {

        break;
      }


      if (
        produto.id &&
        ids.has(
          produto.id
        )
      ) {

        continue;
      }


      if (
        produtoIndesejado(
          produto.titulo
        )
      ) {

        continue;
      }


      selecionados.push(
        produto
      );


      if (produto.id) {

        ids.add(
          produto.id
        );
      }
    }
  }


  return selecionados
    .slice(
      0,
      quantidade
    )
    .map(
      produto => {

        const {
          grupo,
          pontuacao,
          comissaoPercentual,
          ...limpo
        } =
          produto;


        return {

          ...limpo,

          score:
            pontuacao
        };
      }
    );
}


// ======================================================
// OFERTAS SHOPEE
// ======================================================

async function buscarOfertasShopee(
  quantidade = 10
) {

  quantidade =
    Math.max(
      1,
      Math.min(
        50,
        Number(
          quantidade ||
          10
        )
      )
    );


  const candidatos =
    await buscarCandidatosShopee(
      quantidade
    );


  console.log(
    "Shopee candidatos:",
    candidatos.length
  );


  const selecionados =
    selecionarMelhoresShopee(
      candidatos,
      quantidade
    );


  console.log(
    "Shopee selecionados:",
    selecionados.length
  );


  return {

    candidatos:
      candidatos.length,

    ofertas:
      selecionados
  };
}


// ======================================================
// DESTINO WHATSAPP
// ======================================================

function formatarDestino(
  destino,
  tipo
) {

  if (!destino) {

    throw new Error(
      "Destino não informado."
    );
  }


  const valor =
    String(
      destino
    ).trim();


  if (
    tipo ===
    "grupo"
  ) {

    if (
      valor.endsWith(
        "@g.us"
      )
    ) {

      return valor;
    }


    throw new Error(
      "ID de grupo inválido."
    );
  }


  const numero =
    valor.replace(
      /\D/g,
      ""
    );


  return (
    `${numero}@s.whatsapp.net`
  );
}


// ======================================================
// DISPARADOR AUTOMÁTICO
// ======================================================

function configuracaoPadraoDisparador() {

  return {

    ativo:
      false,

    pausado:
      false,

    finalizado:
      false,

    destino:
      null,

    tipo:
      "grupo",

    intervalo_segundos:
      INTERVALO_PADRAO_SEGUNDOS,

    total:
      0,

    enviados:
      0,

    iniciado_em:
      null,

    proximo_disparo_em:
      null,

    ultimo_disparo_em:
      null,

    ultimo_erro:
      null
  };
}


function carregarDisparador() {

  const salvo =
    lerJSON(
      DISPARADOR_FILE
    );


  const padrao =
    configuracaoPadraoDisparador();


  if (
    !salvo ||
    typeof salvo !==
      "object"
  ) {

    return padrao;
  }


  return {
    ...padrao,
    ...salvo
  };
}


function salvarDisparador(
  config
) {

  salvarJSON(
    DISPARADOR_FILE,
    config
  );
}


function resetarDisparador() {

  const config =
    configuracaoPadraoDisparador();


  salvarDisparador(
    config
  );


  return config;
}


function segundosAteProximo(
  config
) {

  if (
    !config?.ativo ||
    config?.pausado ||
    !config?.proximo_disparo_em
  ) {

    return null;
  }


  const alvo =
    new Date(
      config.proximo_disparo_em
    ).getTime();


  if (
    !Number.isFinite(
      alvo
    )
  ) {

    return null;
  }


  return Math.max(
    0,
    Math.ceil(
      (
        alvo -
        Date.now()
      ) /
      1000
    )
  );
}


function resumoDisparador() {

  const config =
    carregarDisparador();


  const fila =
    carregarFila();


  const pendentes =
    fila.filter(
      item =>
        item.status ===
        "pendente"
    ).length;


  return {

    ...config,

    pendentes,

    segundos_restantes:
      segundosAteProximo(
        config
      )
  };
}


// ======================================================
// MENSAGEM DA OFERTA
// ======================================================

function formatarMensagemOferta(
  oferta
) {

  const marketplace =
    String(
      oferta?.marketplace ||
      ""
    )
      .trim()
      .toUpperCase();


  let plataforma =
    marketplace;


  if (
    marketplace ===
    "MERCADOLIVRE"
  ) {

    plataforma =
      "MERCADO LIVRE";
  }


  let texto =
    `🔥 OFERTA ${plataforma} 🔥\n\n`;


  texto +=
    `📦 ${oferta?.titulo || ""}\n\n`;


  const precoAtual =
    Number(
      oferta?.preco_numerico ||
      0
    );


  const precoOriginal =
    Number(
      oferta?.preco_original_numerico ||
      0
    );


  if (
    oferta?.preco_original &&
    precoOriginal >
      precoAtual
  ) {

    texto +=
      `❌ De: ~R$ ${oferta.preco_original}~\n`;
  }


  if (
    oferta?.preco
  ) {

    texto +=
      `💥 Por: R$ ${oferta.preco}\n\n`;
  }


  texto +=
    "Clique aqui\n";


  texto +=
    `👉 ${oferta?.link || ""}`;


  return texto;
}


// ======================================================
// ENVIAR OFERTA
// ======================================================

async function enviarOfertaWhatsApp(
  oferta,
  destino,
  tipo = "grupo"
) {

  if (
    !sock ||
    !conectado
  ) {

    throw new Error(
      "WhatsApp não conectado."
    );
  }


  const jid =
    formatarDestino(
      destino,
      tipo
    );


  const mensagem =
    formatarMensagemOferta(
      oferta
    );


  const imagem =
    String(
      oferta?.imagem ||
      ""
    ).trim();


  if (imagem) {

    try {

      return await sock.sendMessage(
        jid,
        {

          image: {
            url:
              imagem
          },

          caption:
            mensagem
        }
      );
    }

    catch (
      erroImagem
    ) {

      console.error(
        "Falha ao enviar imagem. Tentando texto:",
        erroImagem?.message ||
        erroImagem
      );
    }
  }


  return await sock.sendMessage(
    jid,
    {

      text:
        mensagem
    }
  );
}


// ======================================================
// PROCESSAR DISPARADOR
// ======================================================

let processandoDisparo =
  false;


async function processarDisparadorAutomatico() {

  if (
    processandoDisparo ||
    !conectado ||
    pareandoWhatsApp ||
    controleWhatsApp.requiresManualResume
  ) {

    return;
  }


  const config =
    carregarDisparador();


  if (
    !config.ativo ||
    config.pausado ||
    config.finalizado
  ) {

    return;
  }


  if (!config.destino) {

    config.ativo =
      false;

    config.ultimo_erro =
      "Destino do WhatsApp não configurado.";

    salvarDisparador(
      config
    );

    return;
  }


  const agora =
    Date.now();


  const proximo =
    config.proximo_disparo_em
      ? new Date(
          config.proximo_disparo_em
        ).getTime()
      : 0;


  if (
    Number.isFinite(
      proximo
    ) &&
    proximo > agora
  ) {

    return;
  }


  processandoDisparo =
    true;


  try {

    const fila =
      carregarFila();


    const indice =
      fila.findIndex(
        item =>
          item.status ===
          "pendente"
      );


    if (
      indice === -1
    ) {

      config.ativo =
        false;

      config.finalizado =
        true;

      config.proximo_disparo_em =
        null;

      config.ultimo_erro =
        null;


      salvarDisparador(
        config
      );


      console.log(
        "Disparador finalizado: fila sem pendências."
      );


      return;
    }


    const oferta =
      fila[indice];


    oferta.status =
      "enviando";


    salvarFila(
      fila
    );


    try {

      await enviarOfertaWhatsApp(
        oferta,
        config.destino,
        config.tipo
      );


      oferta.status =
        "enviado";

      oferta.enviado_em =
        new Date()
          .toISOString();

      oferta.erro_envio =
        null;


      config.enviados =
        Number(
          config.enviados ||
          0
        ) + 1;


      config.ultimo_disparo_em =
        new Date()
          .toISOString();


      config.ultimo_erro =
        null;


      const aindaPendentes =
        fila.some(
          (
            item,
            i
          ) =>
            i !== indice &&
            item.status ===
              "pendente"
        );


      if (
        aindaPendentes
      ) {

        config.proximo_disparo_em =
          new Date(
            Date.now() +
            (
              Number(
                config.intervalo_segundos ||
                INTERVALO_PADRAO_SEGUNDOS
              ) *
              1000
            )
          )
            .toISOString();
      }

      else {

        config.ativo =
          false;

        config.finalizado =
          true;

        config.proximo_disparo_em =
          null;
      }


      salvarFila(
        fila
      );


      salvarDisparador(
        config
      );


      console.log(
        `Oferta enviada automaticamente: ${config.enviados}/${config.total}`
      );
    }

    catch (erro) {

      oferta.status =
        "pendente";

      oferta.erro_envio =
        erro.message;


      config.ultimo_erro =
        erro.message;


      config.proximo_disparo_em =
        new Date(
          Date.now() +
          (
            Number(
              config.intervalo_segundos ||
              INTERVALO_PADRAO_SEGUNDOS
            ) *
            1000
          )
        )
          .toISOString();


      salvarFila(
        fila
      );


      salvarDisparador(
        config
      );


      console.error(
        "Erro no disparo automático:",
        erro
      );
    }
  }

  finally {

    processandoDisparo =
      false;
  }
}


// ======================================================
// PREPARAR DISPARADOR
// ======================================================

if (
  !fs.existsSync(
    DISPARADOR_FILE
  )
) {

  resetarDisparador();
}


// Se o servidor reiniciar no meio de um envio,
// devolve o produto para pendente.

{
  const filaInicial =
    carregarFila();

  let alterou =
    false;


  for (
    const item of filaInicial
  ) {

    if (
      item.status ===
      "enviando"
    ) {

      item.status =
        "pendente";

      alterou =
        true;
    }
  }


  if (alterou) {

    salvarFila(
      filaInicial
    );
  }
}


// ======================================================
// INICIAR WHATSAPP
// ======================================================

await iniciarWhatsApp();


// ======================================================
// LOOP DO DISPARADOR
// ======================================================

setInterval(
  () => {

    processarDisparadorAutomatico()
      .catch(
        erro => {

          console.error(
            "Erro no ciclo do disparador:",
            erro
          );
        }
      );
  },
  1000
);


// ======================================================
// SERVIDOR HTTP
// ======================================================

const server =
  http.createServer(
    async (
      req,
      res
    ) => {

      aplicarCORS(
        res
      );


      // ==================================================
      // OPTIONS
      // ==================================================

      if (
        req.method ===
        "OPTIONS"
      ) {

        res.writeHead(
          204
        );

        res.end();

        return;
      }


      const url =
        new URL(
          req.url,
          `http://${req.headers.host}`
        );


      const caminho =
        url.pathname;


// ======================================================
// VINCULAÇÃO (chave somente no cabeçalho)
// ======================================================

      if (caminho === "/pair" && (req.method === "POST" || req.method === "GET")) {
        await atenderPareamento(req, res);
        return;
      }

// ======================================================
// STATUS
// ======================================================

      if (
        req.method ===
          "GET" &&
        caminho ===
          "/status"
      ) {

        const tokenML =
          lerJSON(
            ML_TOKEN_FILE
          );


        const fila =
          carregarFila();


        responderJSON(
          res,
          200,
          {

            servidor:
              "online",

            whatsapp:
              conectado
                ? "conectado"
                : "desconectado",

            whatsapp_status: status,
            retomada_manual_necessaria: controleWhatsApp.requiresManualResume,

            mercado_livre:
              tokenML?.access_token
                ? "autorizado"
                : "não autorizado",

            shopee:
              (
                SHOPEE_APP_ID &&
                SHOPEE_SECRET
              )
                ? "configurada"
                : "não configurada",

            fila:
              fila.length,

            pendentes:
              fila.filter(
                item =>
                  item.status ===
                  "pendente"
              ).length,

            disparador:
              resumoDisparador()
          }
        );


        return;
      }


// ======================================================
// SHOPEE - TESTE
// ======================================================

      if (
        req.method ===
          "GET" &&
        caminho ===
          "/shopee/teste"
      ) {

        try {

          const resultado =
            await testarShopee();


          responderJSON(
            res,
            resultado.sucesso
              ? 200
              : 400,
            resultado
          );
        }

        catch (erro) {

          console.error(
            "Erro teste Shopee:",
            erro
          );


          responderJSON(
            res,
            500,
            {

              sucesso:
                false,

              erro:
                erro.message
            }
          );
        }


        return;
      }


// ======================================================
// SHOPEE - OFERTAS
// ======================================================

      if (
        req.method ===
          "GET" &&
        caminho ===
          "/shopee/ofertas"
      ) {

        try {

          let quantidade =
            Number(
              url.searchParams.get(
                "quantidade"
              ) ||
              10
            );


          quantidade =
            Math.max(
              1,
              Math.min(
                50,
                quantidade
              )
            );


          const resultado =
            await buscarOfertasShopee(
              quantidade
            );


          responderJSON(
            res,
            200,
            {

              sucesso:
                true,

              plataforma:
                "SHOPEE",

              solicitado:
                quantidade,

              candidatos_analisados:
                resultado.candidatos,

              total:
                resultado.ofertas.length,

              ofertas:
                resultado.ofertas
            }
          );
        }

        catch (erro) {

          console.error(
            "Erro ofertas Shopee:",
            erro
          );


          responderJSON(
            res,
            500,
            {

              sucesso:
                false,

              erro:
                erro.message
            }
          );
        }


        return;
      }


// ======================================================
// MERCADO LIVRE - LOGIN
// ======================================================

      if (
        req.method ===
          "GET" &&
        caminho ===
          "/mercadolivre/login"
      ) {

        try {

          if (
            !ML_CLIENT_ID ||
            !ML_CLIENT_SECRET
          ) {

            throw new Error(
              "Mercado Livre não configurado."
            );
          }


          const state =
            crypto
              .randomBytes(24)
              .toString("hex");


          const {
            codeVerifier,
            codeChallenge
          } =
            criarPKCE();


          salvarJSON(
            ML_OAUTH_FILE,
            {

              state,

              codeVerifier,

              criado_em:
                Date.now()
            }
          );


          const autorizacao =
            new URL(
              "https://auth.mercadolivre.com.br/authorization"
            );


          autorizacao
            .searchParams
            .set(
              "response_type",
              "code"
            );


          autorizacao
            .searchParams
            .set(
              "client_id",
              ML_CLIENT_ID
            );


          autorizacao
            .searchParams
            .set(
              "redirect_uri",
              ML_REDIRECT_URI
            );


          autorizacao
            .searchParams
            .set(
              "state",
              state
            );


          autorizacao
            .searchParams
            .set(
              "code_challenge",
              codeChallenge
            );


          autorizacao
            .searchParams
            .set(
              "code_challenge_method",
              "S256"
            );


          res.writeHead(
            302,
            {
              Location:
                autorizacao.toString()
            }
          );


          res.end();
        }

        catch (erro) {

          responderJSON(
            res,
            500,
            {

              sucesso:
                false,

              erro:
                erro.message
            }
          );
        }


        return;
      }


// ======================================================
// MERCADO LIVRE - CALLBACK
// ======================================================

      if (
        req.method ===
          "GET" &&
        caminho ===
          "/mercadolivre/callback"
      ) {

        try {

          const code =
            url.searchParams.get(
              "code"
            );


          const state =
            url.searchParams.get(
              "state"
            );


          const oauth =
            lerJSON(
              ML_OAUTH_FILE
            );


          if (
            !code ||
            !oauth ||
            state !==
              oauth.state
          ) {

            throw new Error(
              "Falha na autorização."
            );
          }


          await trocarCodePorToken(
            code,
            oauth.codeVerifier
          );


          res.writeHead(
            200,
            {
              "Content-Type":
                "text/html; charset=utf-8"
            }
          );


          res.end(
            `
            <body style="
              background:#111827;
              color:white;
              font-family:Arial;
              text-align:center;
              padding:60px;
            ">

              <h1>
                ✅ Mercado Livre conectado!
              </h1>

            </body>
            `
          );
        }

        catch (erro) {

          responderJSON(
            res,
            500,
            {

              sucesso:
                false,

              erro:
                erro.message
            }
          );
        }


        return;
      }


// ======================================================
// FILA - VER
// ======================================================

      if (
        req.method ===
          "GET" &&
        caminho ===
          "/fila"
      ) {

        if (
          !chaveValida(
            req
          )
        ) {

          responderJSON(
            res,
            401,
            {

              sucesso:
                false,

              erro:
                "Chave inválida."
            }
          );


          return;
        }


        const fila =
          carregarFila();


        responderJSON(
          res,
          200,
          {

            sucesso:
              true,

            total:
              fila.length,

            pendentes:
              fila.filter(
                item =>
                  item.status ===
                  "pendente"
              ).length,

            ofertas:
              fila
          }
        );


        return;
      }


// ======================================================
// FILA - ADICIONAR
// ======================================================

      if (
        req.method ===
          "POST" &&
        caminho ===
          "/fila/adicionar"
      ) {

        try {

          if (
            !chaveValida(
              req
            )
          ) {

            responderJSON(
              res,
              401,
              {

                sucesso:
                  false,

                erro:
                  "Chave inválida."
              }
            );


            return;
          }


          const body =
            await lerBodyJSON(
              req
            );


          let recebidas = [];


          if (
            Array.isArray(
              body.ofertas
            )
          ) {

            recebidas =
              body.ofertas;
          }

          else if (
            body.oferta
          ) {

            recebidas = [
              body.oferta
            ];
          }


          if (
            recebidas.length === 0
          ) {

            throw new Error(
              "Nenhuma oferta recebida."
            );
          }


          const fila =
            carregarFila();


          const existentes =
            new Set();


          for (
            const item of fila
          ) {

            if (
              item.produto_id
            ) {

              existentes.add(
                `${item.marketplace}:id:${item.produto_id}`
              );
            }


            if (
              item.link
            ) {

              existentes.add(
                `${item.marketplace}:link:${item.link}`
              );
            }
          }


          let adicionadas = 0;

          let repetidas = 0;

          let invalidas = 0;


          for (
            const recebida of recebidas
          ) {

            const oferta =
              normalizarOferta(
                recebida
              );


            if (!oferta) {

              invalidas++;

              continue;
            }


            const chaveId =
              oferta.produto_id
                ? `${oferta.marketplace}:id:${oferta.produto_id}`
                : null;


            const chaveLink =
              `${oferta.marketplace}:link:${oferta.link}`;


            if (
              (
                chaveId &&
                existentes.has(
                  chaveId
                )
              ) ||
              existentes.has(
                chaveLink
              )
            ) {

              repetidas++;

              continue;
            }


            fila.push(
              oferta
            );


            if (chaveId) {

              existentes.add(
                chaveId
              );
            }


            existentes.add(
              chaveLink
            );


            adicionadas++;
          }


          salvarFila(
            fila
          );


          responderJSON(
            res,
            200,
            {

              sucesso:
                true,

              recebidas:
                recebidas.length,

              adicionadas,

              repetidas,

              invalidas,

              total_na_fila:
                fila.length
            }
          );
        }

        catch (erro) {

          responderJSON(
            res,
            500,
            {

              sucesso:
                false,

              erro:
                erro.message
            }
          );
        }


        return;
      }


// ======================================================
// FILA - LIMPAR
// ======================================================

      if (
        req.method ===
          "POST" &&
        caminho ===
          "/fila/limpar"
      ) {

        if (
          !chaveValida(
            req
          )
        ) {

          responderJSON(
            res,
            401,
            {

              sucesso:
                false,

              erro:
                "Chave inválida."
            }
          );


          return;
        }


        salvarFila(
          []
        );


        resetarDisparador();


        responderJSON(
          res,
          200,
          {

            sucesso:
              true,

            mensagem:
              "Fila limpa."
          }
        );


        return;
      }


// ======================================================
// DISPARADOR - STATUS
// ======================================================

      if (
        req.method ===
          "GET" &&
        caminho ===
          "/disparador/status"
      ) {

        if (
          !chaveValida(
            req
          )
        ) {

          responderJSON(
            res,
            401,
            {

              sucesso:
                false,

              erro:
                "Chave inválida."
            }
          );


          return;
        }


        responderJSON(
          res,
          200,
          {

            sucesso:
              true,

            disparador:
              resumoDisparador()
          }
        );


        return;
      }


// ======================================================
// DISPARADOR - INICIAR
// ======================================================

      if (
        req.method ===
          "POST" &&
        caminho ===
          "/disparador/iniciar"
      ) {

        try {

          if (
            !chaveValida(
              req
            )
          ) {

            responderJSON(
              res,
              401,
              {

                sucesso:
                  false,

                erro:
                  "Chave inválida."
              }
            );


            return;
          }

          if (!conectado || pareandoWhatsApp) {
            throw new Error("WhatsApp não conectado ou em vinculação.");
          }
          const contextoRetomada = contextoWhatsApp;


          if (
            !sock ||
            !conectado
          ) {

            throw new Error(
              "WhatsApp não conectado."
            );
          }


          const body =
            await lerBodyJSON(
              req
            );


          const destino =
            String(
              body.destino ||
              ""
            ).trim();


          if (!destino) {

            throw new Error(
              "Grupo de destino não informado."
            );
          }


          formatarDestino(
            destino,
            "grupo"
          );


          let intervaloSegundos =
            Number(
              body.intervaloSegundos ||
              body.intervalo_segundos ||
              INTERVALO_PADRAO_SEGUNDOS
            );


          if (
            !Number.isFinite(
              intervaloSegundos
            )
          ) {

            intervaloSegundos =
              INTERVALO_PADRAO_SEGUNDOS;
          }


          intervaloSegundos =
            Math.max(
              10,
              Math.min(
                86400,
                Math.round(
                  intervaloSegundos
                )
              )
            );


          const fila =
            carregarFila();


          const pendentes =
            fila.filter(
              item =>
                item.status ===
                "pendente"
            ).length;


          if (
            pendentes === 0
          ) {

            throw new Error(
              "Não há ofertas pendentes na fila."
            );
          }


          const config = {

            ...configuracaoPadraoDisparador(),

            ativo:
              true,

            pausado:
              false,

            finalizado:
              false,

            destino,

            tipo:
              "grupo",

            intervalo_segundos:
              intervaloSegundos,

            total:
              pendentes,

            enviados:
              0,

            iniciado_em:
              new Date()
                .toISOString(),

            proximo_disparo_em:
              new Date()
                .toISOString(),

            ultimo_disparo_em:
              null,

            ultimo_erro:
              null
          };


          if (!conectado || pareandoWhatsApp || contextoWhatsApp !== contextoRetomada) {
            throw new Error("A conexão mudou. Confirme a retomada novamente.");
          }

          salvarDisparador(
            config
          );

          salvarControleWhatsApp({ requiresManualResume: false });


          responderJSON(
            res,
            200,
            {

              sucesso:
                true,

              mensagem:
                "Disparador iniciado.",

              disparador:
                resumoDisparador()
            }
          );
        }

        catch (erro) {

          responderJSON(
            res,
            500,
            {

              sucesso:
                false,

              erro:
                erro.message
            }
          );
        }


        return;
      }


// ======================================================
// DISPARADOR - PAUSAR
// ======================================================

      if (
        req.method ===
          "POST" &&
        caminho ===
          "/disparador/pausar"
      ) {

        if (
          !chaveValida(
            req
          )
        ) {

          responderJSON(
            res,
            401,
            {

              sucesso:
                false,

              erro:
                "Chave inválida."
            }
          );


          return;
        }


        const config =
          carregarDisparador();


        config.ativo =
          true;

        config.pausado =
          true;

        config.finalizado =
          false;

        config.proximo_disparo_em =
          null;


        salvarDisparador(
          config
        );


        responderJSON(
          res,
          200,
          {

            sucesso:
              true,

            mensagem:
              "Disparador pausado.",

            disparador:
              resumoDisparador()
          }
        );


        return;
      }


// ======================================================
// DISPARADOR - CONTINUAR
// ======================================================

      if (
        req.method ===
          "POST" &&
        caminho ===
          "/disparador/continuar"
      ) {

        try {

          if (
            !chaveValida(
              req
            )
          ) {

            responderJSON(
              res,
              401,
              {

                sucesso:
                  false,

                erro:
                  "Chave inválida."
              }
            );


            return;
          }

          if (!conectado || pareandoWhatsApp) {
            throw new Error("WhatsApp não conectado ou em vinculação.");
          }
          const contextoRetomada = contextoWhatsApp;


          const fila =
            carregarFila();


          const pendentes =
            fila.filter(
              item =>
                item.status ===
                "pendente"
            ).length;


          if (
            pendentes === 0
          ) {

            throw new Error(
              "Não há ofertas pendentes para continuar."
            );
          }


          const config =
            carregarDisparador();


          if (
            !config.destino
          ) {

            throw new Error(
              "Nenhum grupo configurado no disparador."
            );
          }


          config.ativo =
            true;

          config.pausado =
            false;

          config.finalizado =
            false;

          config.proximo_disparo_em =
            new Date()
              .toISOString();

          config.ultimo_erro =
            null;


          if (!conectado || pareandoWhatsApp || contextoWhatsApp !== contextoRetomada) {
            throw new Error("A conexão mudou. Confirme a retomada novamente.");
          }

          salvarDisparador(
            config
          );

          salvarControleWhatsApp({ requiresManualResume: false });


          responderJSON(
            res,
            200,
            {

              sucesso:
                true,

              mensagem:
                "Disparador continuado.",

              disparador:
                resumoDisparador()
            }
          );
        }

        catch (erro) {

          responderJSON(
            res,
            500,
            {

              sucesso:
                false,

              erro:
                erro.message
            }
          );
        }


        return;
      }


// ======================================================
// DISPARADOR - PARAR
// ======================================================

      if (
        req.method ===
          "POST" &&
        caminho ===
          "/disparador/parar"
      ) {

        if (
          !chaveValida(
            req
          )
        ) {

          responderJSON(
            res,
            401,
            {

              sucesso:
                false,

              erro:
                "Chave inválida."
            }
          );


          return;
        }


        const config =
          carregarDisparador();


        config.ativo =
          false;

        config.pausado =
          false;

        config.finalizado =
          false;

        config.proximo_disparo_em =
          null;


        salvarDisparador(
          config
        );


        responderJSON(
          res,
          200,
          {

            sucesso:
              true,

            mensagem:
              "Disparador parado.",

            disparador:
              resumoDisparador()
          }
        );


        return;
      }


// ======================================================
// GRUPOS
// ======================================================

      if (
        req.method ===
          "GET" &&
        caminho ===
          "/grupos"
      ) {

        try {

          if (
            !chaveValida(
              req
            )
          ) {

            responderJSON(
              res,
              401,
              {

                sucesso:
                  false,

                erro:
                  "Chave inválida."
              }
            );


            return;
          }


          if (
            !sock ||
            !conectado
          ) {

            throw new Error(
              "WhatsApp não conectado."
            );
          }


          const grupos =
            await sock
              .groupFetchAllParticipating();


          const lista =
            Object.values(
              grupos
            )
              .map(
                grupo => ({

                  nome:
                    grupo.subject,

                  id:
                    grupo.id,

                  participantes:
                    grupo
                      .participants
                      ?.length ||
                    0
                })
              );


          responderJSON(
            res,
            200,
            {

              sucesso:
                true,

              grupos:
                lista
            }
          );
        }

        catch (erro) {

          responderJSON(
            res,
            500,
            {

              sucesso:
                false,

              erro:
                erro.message
            }
          );
        }


        return;
      }


// ======================================================
// SEND MANUAL
// ======================================================

      if (
        req.method ===
          "POST" &&
        caminho ===
          "/send"
      ) {

        try {

          if (
            !chaveValida(
              req
            )
          ) {

            responderJSON(
              res,
              401,
              {

                sucesso:
                  false,

                erro:
                  "Chave inválida."
              }
            );


            return;
          }


          if (
            !sock ||
            !conectado
          ) {

            throw new Error(
              "WhatsApp não conectado."
            );
          }


          const body =
            await lerBodyJSON(
              req
            );


          if (
            !body.mensagem
          ) {

            throw new Error(
              "Mensagem não informada."
            );
          }


          const jid =
            formatarDestino(
              body.destino,
              body.tipo
            );


          const imagem =
            String(
              body.imagem ||
              ""
            ).trim();


          let resultado;


          if (imagem) {

            try {

              resultado =
                await sock.sendMessage(
                  jid,
                  {

                    image: {
                      url:
                        imagem
                    },

                    caption:
                      String(
                        body.mensagem
                      )
                  }
                );
            }

            catch (
              erroImagem
            ) {

              console.error(
                "Falha ao enviar imagem na rota /send. Tentando texto:",
                erroImagem?.message ||
                erroImagem
              );


              resultado =
                await sock.sendMessage(
                  jid,
                  {

                    text:
                      String(
                        body.mensagem
                      )
                  }
                );
            }
          }

          else {

            resultado =
              await sock.sendMessage(
                jid,
                {

                  text:
                    String(
                      body.mensagem
                    )
                }
              );
          }


          responderJSON(
            res,
            200,
            {

              sucesso:
                true,

              id:
                resultado
                  ?.key
                  ?.id ||
                null
            }
          );
        }

        catch (erro) {

          responderJSON(
            res,
            500,
            {

              sucesso:
                false,

              erro:
                erro.message
            }
          );
        }


        return;
      }


// ======================================================
// PÁGINA INICIAL
// ======================================================

      const fila =
        carregarFila();


      const disparador =
        resumoDisparador();


      res.setHeader("Cache-Control", "no-store");

      res.writeHead(
        200,
        {
          "Content-Type":
            "text/html; charset=utf-8"
        }
      );


      res.end(
        `
        <body style="
          background:#111827;
          color:white;
          font-family:Arial;
          text-align:center;
          padding:50px;
        ">

          <h1>
            ⚡ Achadinhos Automático
          </h1>

          <p>
            WhatsApp:
            ${
              conectado
                ? "✅ conectado"
                : "❌ desconectado"
            }
          </p>

          ${formularioPareamento()}

          ${controleWhatsApp.requiresManualResume
            ? '<p>⏸️ Envios automáticos bloqueados. Inicie ou continue o disparador somente quando desejar enviar.</p>'
            : ''}

          <p>
            Shopee:
            ${
              SHOPEE_APP_ID &&
              SHOPEE_SECRET
                ? "✅ configurada"
                : "❌ não configurada"
            }
          </p>

          <p>
            Fila:
            ${fila.length} ofertas
          </p>

          <p>
            Pendentes:
            ${
              fila.filter(
                item =>
                  item.status ===
                  "pendente"
              ).length
            }
          </p>

          <p>
            Disparador:
            ${
              disparador.finalizado
                ? "✅ Finalizado"
                : disparador.pausado
                  ? "⏸️ Pausado"
                  : disparador.ativo
                    ? "▶️ Em execução"
                    : "⏹️ Parado"
            }
          </p>

          <p>
            Enviados:
            ${disparador.enviados}
            de
            ${disparador.total}
          </p>

          <p>
            Intervalo:
            ${disparador.intervalo_segundos}
            segundos
          </p>

          <p>
            <a
              href="/shopee/teste"
              style="
                color:#fb923c;
                font-size:18px;
              "
            >
              Testar API Shopee
            </a>
          </p>

          <p>
            <a
              href="/shopee/ofertas?quantidade=10"
              style="
                color:#22c55e;
                font-size:18px;
              "
            >
              Buscar 10 ofertas selecionadas
            </a>
          </p>

        </body>
        `
      );
    }
  );


// ======================================================
// INICIAR SERVIDOR
// ======================================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `Servidor rodando na porta ${PORT}`
    );
  }
);
