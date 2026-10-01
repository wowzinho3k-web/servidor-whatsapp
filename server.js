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
// CONFIGURAÇÃO DO FILTRO SHOPEE
// ======================================================

// Evita ofertas muito baratas que normalmente
// têm pouca relevância e itens muito caros/pesados.
const SHOPEE_PRECO_MINIMO =
  15;

const SHOPEE_PRECO_MAXIMO =
  1500;


// Desconto mínimo desejável.
// Se não houver candidatos suficientes,
// há uma segunda passagem mais flexível.
const SHOPEE_DESCONTO_MINIMO =
  10;


// Nota mínima desejável.
const SHOPEE_AVALIACAO_MINIMA =
  4.4;


// Quantos produtos analisar para cada
// oferta que queremos entregar.
const SHOPEE_MULTIPLICADOR_CANDIDATOS =
  5;


// Máximo de candidatos que vamos analisar
// numa única chamada da rota.
const SHOPEE_MAX_CANDIDATOS =
  80;


// ======================================================
// FILA
// ======================================================

const FILA_FILE =
  "/data/fila-ofertas.json";


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


// ======================================================
// CORS
// ======================================================

function aplicarCORS(
  res
) {

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

  aplicarCORS(
    res
  );

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
// CHAVE DE SEGURANÇA
// ======================================================

function chaveValida(
  req
) {

  const recebida =
    req.headers["x-send-key"];

  return (
    SEND_KEY &&
    recebida === SEND_KEY
  );

}


// ======================================================
// BODY JSON
// ======================================================

function lerBodyJSON(
  req
) {

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

            if (
              !body
            ) {

              resolve({});

              return;

            }


            resolve(
              JSON.parse(
                body
              )
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


function lerJSON(
  arquivo
) {

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

  catch (
    erro
  ) {

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


  return Array.isArray(
    fila
  )
    ? fila
    : [];

}


function salvarFila(
  fila
) {

  salvarJSON(
    FILA_FILE,
    fila
  );

}


function criarIdFila() {

  return crypto
    .randomBytes(
      12
    )
    .toString(
      "hex"
    );

}


function normalizarOferta(
  oferta
) {

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
        ? String(
            oferta.id
          )
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
      null

  };

}


// ======================================================
// FORMATAÇÃO
// ======================================================

function formatarNumeroBR(
  valor
) {

  const numero =
    Number(
      valor
    );


  if (
    !Number.isFinite(
      numero
    )
  ) {

    return null;

  }


  return numero
    .toLocaleString(
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

  const {
    state,
    saveCreds
  } =
    await useMultiFileAuthState(
      AUTH_DIR
    );


  sock =
    makeWASocket({

      auth:
        state,

      logger:
        pino({
          level:
            "silent"
        }),

      browser:
        Browsers.ubuntu(
          "Chrome"
        ),

      printQRInTerminal:
        false,

      syncFullHistory:
        false,

      markOnlineOnConnect:
        false

    });


  sock.ev.on(
    "creds.update",
    saveCreds
  );


  sock.ev.on(
    "connection.update",
    update => {

      const {
        connection,
        lastDisconnect
      } =
        update;


      if (
        connection ===
        "open"
      ) {

        conectado =
          true;

        status =
          "WhatsApp conectado.";

        console.log(
          "WhatsApp conectado."
        );

      }


      if (
        connection ===
        "close"
      ) {

        conectado =
          false;


        const statusCode =
          lastDisconnect
            ?.error
            ?.output
            ?.statusCode;


        console.log(
          "WhatsApp desconectou:",
          statusCode
        );


        const saiuDaConta =
          statusCode ===
          DisconnectReason.loggedOut;


        if (
          !saiuDaConta
        ) {

          setTimeout(
            () => {

              iniciarWhatsApp()
                .catch(
                  console.error
                );

            },
            5000
          );

        }

      }

    }
  );

}


await iniciarWhatsApp();


// ======================================================
// MERCADO LIVRE - PKCE
// ======================================================

function base64URL(
  buffer
) {

  return buffer
    .toString(
      "base64"
    )
    .replace(
      /\+/g,
      "-"
    )
    .replace(
      /\//g,
      "_"
    )
    .replace(
      /=+$/g,
      ""
    );

}


function criarPKCE() {

  const codeVerifier =
    base64URL(
      crypto.randomBytes(
        48
      )
    );


  const hash =
    crypto
      .createHash(
        "sha256"
      )
      .update(
        codeVerifier
      )
      .digest();


  const codeChallenge =
    base64URL(
      hash
    );


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


  if (
    codeVerifier
  ) {

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


  if (
    !resposta.ok
  ) {

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
      .createHash(
        "sha256"
      )
      .update(
        base,
        "utf8"
      )
      .digest(
        "hex"
      );


  return {
    timestamp,
    signature
  };

}


// ======================================================
// SHOPEE - CONSULTA GRAPHQL
// ======================================================

async function consultarShopee(
  query,
  variables = {}
) {

  if (
    !SHOPEE_APP_ID
  ) {

    throw new Error(
      "SHOPEE_APP_ID não configurado."
    );

  }


  if (
    !SHOPEE_SECRET
  ) {

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
      JSON.parse(
        texto
      );

  }

  catch {

    throw new Error(
      `Shopee respondeu HTTP ${resposta.status}, mas não retornou JSON.`
    );

  }


  if (
    !resposta.ok
  ) {

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
        page:
          1,

        limit:
          1
      }
    );


  if (
    resposta?.errors?.length
  ) {

    return {

      sucesso:
        false,

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
// SHOPEE - TEXTO NORMALIZADO
// ======================================================

function normalizarTexto(
  texto
) {

  return String(
    texto ||
    ""
  )
    .normalize(
      "NFD"
    )
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
// SHOPEE - PALAVRAS DO PRODUTO
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


function palavrasProduto(
  titulo
) {

  return normalizarTexto(
    titulo
  )
    .split(
      " "
    )
    .filter(
      palavra =>
        palavra.length >=
          4 &&
        !PALAVRAS_IGNORADAS.has(
          palavra
        )
    );

}


// ======================================================
// SHOPEE - SIMILARIDADE DE TÍTULOS
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
    const palavra of
    a
  ) {

    if (
      b.has(
        palavra
      )
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
// SHOPEE - GRUPO DO PRODUTO
// ======================================================

function descobrirGrupoProduto(
  titulo
) {

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
    const grupo of
    grupos
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
// SHOPEE - ITENS GRANDES/POUCO INTERESSANTES
// ======================================================

function produtoIndesejado(
  titulo
) {

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
// SHOPEE - CALCULAR COMISSÃO EM %
// ======================================================

function obterComissaoPercentual(
  valor
) {

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

    return numero *
      100;

  }


  return numero;

}


// ======================================================
// SHOPEE - CALCULAR PREÇO ANTIGO
// ======================================================

function calcularPrecoOriginal(
  precoAtual,
  desconto
) {

  const atual =
    Number(
      precoAtual
    );


  const percentual =
    Number(
      desconto
    );


  if (
    !Number.isFinite(
      atual
    ) ||
    !Number.isFinite(
      percentual
    ) ||
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
      (
        percentual /
        100
      )
    );


  if (
    original <=
    atual
  ) {

    return 0;

  }


  return Number(
    original.toFixed(
      2
    )
  );

}


// ======================================================
// SHOPEE - NOTA DA OFERTA
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


  // Desconto pesa bastante.
  let pontos =
    desconto *
    1.4;


  // Vendas ajudam muito,
  // mas usamos log para não deixar
  // um produto com milhões de vendas
  // dominar tudo.
  pontos +=
    Math.log10(
      vendas +
      1
    ) *
    14;


  // Avaliação.
  pontos +=
    avaliacao *
    8;


  // Comissão.
  pontos +=
    comissao *
    0.7;


  // Faixas de preço que costumam
  // ser mais fáceis de divulgar.
  if (
    preco >= 25 &&
    preco <= 200
  ) {

    pontos +=
      18;

  }

  else if (
    preco > 200 &&
    preco <= 500
  ) {

    pontos +=
      10;

  }

  else if (
    preco > 500 &&
    preco <= 1000
  ) {

    pontos +=
      3;

  }


  return Number(
    pontos.toFixed(
      2
    )
  );

}


// ======================================================
// SHOPEE - NORMALIZAR PRODUTO DA API
// ======================================================

function normalizarProdutoShopee(
  produto
) {

  if (
    !produto
  ) {

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
// SHOPEE - BUSCAR CANDIDATOS
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


  const candidatos =
    [];


  const ids =
    new Set();


  const POR_PAGINA =
    20;


  let pagina =
    1;


  let temProxima =
    true;


  while (
    candidatos.length <
      alvo &&
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
      bloco
        ?.nodes;


    if (
      !Array.isArray(
        produtos
      ) ||
      produtos.length ===
        0
    ) {

      break;

    }


    for (
      const bruto of
      produtos
    ) {

      const produto =
        normalizarProdutoShopee(
          bruto
        );


      if (
        !produto
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
        produto.id
      ) {

        ids.add(
          produto.id
        );

      }


      candidatos.push(
        produto
      );


      if (
        candidatos.length >=
        alvo
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
// SHOPEE - PRODUTO ACEITÁVEL
// ======================================================

function produtoAceitavel(
  produto,
  flexivel = false
) {

  if (
    !produto
  ) {

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


  if (
    !flexivel
  ) {

    if (
      produto.desconto <
      SHOPEE_DESCONTO_MINIMO
    ) {

      return false;

    }


    if (
      produto.avaliacao >
        0 &&
      produto.avaliacao <
        SHOPEE_AVALIACAO_MINIMA
    ) {

      return false;

    }

  }


  return true;

}


// ======================================================
// SHOPEE - MUITO PARECIDO COM JÁ SELECIONADO
// ======================================================

function muitoParecido(
  candidato,
  selecionados
) {

  for (
    const escolhido of
    selecionados
  ) {

    const similaridade =
      similaridadeTitulos(
        candidato.titulo,
        escolhido.titulo
      );


    if (
      similaridade >=
      0.42
    ) {

      return true;

    }

  }


  return false;

}


// ======================================================
// SHOPEE - SELEÇÃO INTELIGENTE
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
        (
          a,
          b
        ) =>
          b.pontuacao -
          a.pontuacao
      );


  const selecionados =
    [];


  const gruposUsados =
    new Map();


  const ids =
    new Set();


  // ==================================================
  // PRIMEIRA PASSAGEM
  // Mais exigente e prioriza variedade.
  // ==================================================

  for (
    const produto of
    ordenados
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


    if (
      produto.grupo
    ) {

      const usados =
        gruposUsados.get(
          produto.grupo
        ) ||
        0;


      // Na primeira rodada,
      // no máximo 1 produto de cada grupo.
      if (
        usados >= 1
      ) {

        continue;

      }

    }


    selecionados.push(
      produto
    );


    if (
      produto.id
    ) {

      ids.add(
        produto.id
      );

    }


    if (
      produto.grupo
    ) {

      gruposUsados.set(
        produto.grupo,
        (
          gruposUsados.get(
            produto.grupo
          ) ||
          0
        ) +
        1
      );

    }

  }


  // ==================================================
  // SEGUNDA PASSAGEM
  // Se faltou produto, permite até 2 do mesmo grupo.
  // ==================================================

  if (
    selecionados.length <
    quantidade
  ) {

    for (
      const produto of
      ordenados
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


      if (
        produto.grupo
      ) {

        const usados =
          gruposUsados.get(
            produto.grupo
          ) ||
          0;


        if (
          usados >= 2
        ) {

          continue;

        }

      }


      selecionados.push(
        produto
      );


      if (
        produto.id
      ) {

        ids.add(
          produto.id
        );

      }


      if (
        produto.grupo
      ) {

        gruposUsados.set(
          produto.grupo,
          (
            gruposUsados.get(
              produto.grupo
            ) ||
            0
          ) +
          1
        );

      }

    }

  }


  // ==================================================
  // TERCEIRA PASSAGEM
  // Mais flexível para conseguir completar a quantidade.
  // ==================================================

  if (
    selecionados.length <
    quantidade
  ) {

    for (
      const produto of
      ordenados
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


      if (
        produto.id
      ) {

        ids.add(
          produto.id
        );

      }

    }

  }


  // ==================================================
  // ÚLTIMA PASSAGEM
  // Se ainda não completou, usa os restantes válidos.
  // ==================================================

  if (
    selecionados.length <
    quantidade
  ) {

    for (
      const produto of
      ordenados
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


      if (
        produto.id
      ) {

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

        // Retira informações internas
        // que não precisam ir para a extensão.

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
// SHOPEE - BUSCAR OFERTAS FINAIS
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

  if (
    !destino
  ) {

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
              ).length

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

        catch (
          erro
        ) {

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

        catch (
          erro
        ) {

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
              .randomBytes(
                24
              )
              .toString(
                "hex"
              );


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

        catch (
          erro
        ) {

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

        catch (
          erro
        ) {

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


          let recebidas =
            [];


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

            recebidas =
              [
                body.oferta
              ];

          }


          if (
            recebidas.length ===
            0
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
            const item of
            fila
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


          let adicionadas =
            0;

          let repetidas =
            0;

          let invalidas =
            0;


          for (
            const recebida of
            recebidas
          ) {

            const oferta =
              normalizarOferta(
                recebida
              );


            if (
              !oferta
            ) {

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


            if (
              chaveId
            ) {

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

        catch (
          erro
        ) {

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

        catch (
          erro
        ) {

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
// SEND
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


          const conteudo =
            imagem
              ? {

                  image: {
                    url:
                      imagem
                  },

                  caption:
                    String(
                      body.mensagem
                    )

                }
              : {

                  text:
                    String(
                      body.mensagem
                    )

                };


          const resultado =
            await sock.sendMessage(
              jid,
              conteudo
            );


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

        catch (
          erro
        ) {

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
