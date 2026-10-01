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
// CONFIGURAÇÕES
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
// CHAVE
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

            if (!body) {

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
// JSON
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
// FORMATAR VALOR
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
// SHOPEE - CONSULTA
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


  const dados =
    await resposta.json();


  if (
    !resposta.ok
  ) {

    throw new Error(
      `Shopee HTTP ${resposta.status}: ${JSON.stringify(dados)}`
    );

  }


  return dados;

}


// ======================================================
// SHOPEE - TESTE
// ======================================================

async function testarShopee() {

  const query =
    `
      query TesteShopee(
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


  const resposta =
    await consultarShopee(
      query,
      {
        page: 1,
        limit: 1
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
// SHOPEE - BUSCAR OFERTAS
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


  const query =
    `
      query BuscarOfertasShopee(
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


  const resposta =
    await consultarShopee(
      query,
      {
        page:
          1,

        limit:
          quantidade
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


  const produtos =
    resposta
      ?.data
      ?.productOfferV2
      ?.nodes;


  if (
    !Array.isArray(
      produtos
    )
  ) {

    return [];

  }


  const ofertas =
    [];


  for (
    const produto of
    produtos
  ) {

    if (
      !produto
    ) {

      continue;

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


    if (
      !titulo ||
      !link ||
      !precoNumerico
    ) {

      continue;

    }


    ofertas.push({

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

      titulo:
        titulo,

      preco:
        formatarNumeroBR(
          precoNumerico
        ),

      precoNumerico:
        precoNumerico,

      precoOriginalFormatado:
        null,

      precoOriginalNumerico:
        0,

      desconto:
        Number(
          produto.priceDiscountRate ||
          0
        ),

      loja:
        produto.shopName ||
        null,

      vendas:
        Number(
          produto.sales ||
          0
        ),

      avaliacao:
        Number(
          produto.ratingStar ||
          0
        ),

      comissao:
        produto.commissionRate ||
        null,

      imagem:
        produto.imageUrl ||
        null,

      link:
        link

    });

  }


  return ofertas.slice(
    0,
    quantidade
  );

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
// SERVIDOR
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


      // ==================================================
      // STATUS
      // ==================================================

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


      // ==================================================
      // SHOPEE TESTE
      // ==================================================

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


      // ==================================================
      // SHOPEE OFERTAS
      // ==================================================

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


          if (
            quantidade < 1
          ) {

            quantidade =
              1;

          }


          if (
            quantidade > 50
          ) {

            quantidade =
              50;

          }


          const ofertas =
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

              total:
                ofertas.length,

              ofertas:
                ofertas

            }
          );

        }

        catch (
          erro
        ) {

          console.error(
            "Erro buscando Shopee:",
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


      // ==================================================
      // MERCADO LIVRE LOGIN
      // ==================================================

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


      // ==================================================
      // MERCADO LIVRE CALLBACK
      // ==================================================

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


      // ==================================================
      // FILA
      // ==================================================

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


      // ==================================================
      // FILA ADICIONAR
      // ==================================================

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


      // ==================================================
      // FILA LIMPAR
      // ==================================================

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


      // ==================================================
      // GRUPOS
      // ==================================================

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


      // ==================================================
      // SEND
      // ==================================================

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


          const resultado =
            await sock.sendMessage(
              jid,
              {

                text:
                  String(
                    body.mensagem
                  )

              }
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


      // ==================================================
      // PÁGINA INICIAL
      // ==================================================

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
              Testar Shopee
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
              Buscar 10 ofertas da Shopee
            </a>
          </p>

        </body>
        `
      );

    }
  );


// ======================================================
// INICIAR
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
