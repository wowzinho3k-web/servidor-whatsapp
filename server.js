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

const PORT = process.env.PORT || 3000;

const AUTH_DIR = "/data/baileys-auth";

const SEND_KEY =
  process.env.SEND_KEY || "";

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


fs.mkdirSync(
  AUTH_DIR,
  {
    recursive: true
  }
);


// ======================================================
// ESTADO DO WHATSAPP
// ======================================================

let sock = null;

let status =
  "Servidor iniciado.";

let pairingCode = "";

let conectado = false;


// ======================================================
// CONFIGURAÇÃO DO CAÇADOR DE OFERTAS
// ======================================================

const BUSCAS_MERCADO_LIVRE = [

  "furadeira",
  "parafusadeira",
  "chave jogo ferramentas",
  "ferramentas",
  "lavadora alta pressão",

  "air fryer",
  "chaleira elétrica",
  "liquidificador",
  "cafeteira",
  "panela elétrica",

  "celular",
  "smartphone",
  "fone bluetooth",
  "carregador celular",
  "power bank",

  "mouse gamer",
  "teclado gamer",
  "ssd",
  "monitor",
  "caixa de som bluetooth",

  "pesca",
  "rede pesca",
  "kit pesca",

  "aspirador",
  "ventilador",
  "extensão elétrica",
  "luminária",
  "câmera segurança",

  "kit ferramentas automotivas",
  "compressor portátil",
  "multímetro",

  "organizador",
  "potes cozinha",
  "garrafa térmica"

];


// Quantos resultados pegar de cada busca
const LIMITE_POR_BUSCA = 10;


// Desconto mínimo
const DESCONTO_MINIMO = 10;


// Preço máximo inicial.
// Isso ajuda a evitar geladeira, móveis caros etc.
const PRECO_MAXIMO = 3000;


// ======================================================
// FUNÇÕES GERAIS
// ======================================================

function responderJSON(
  res,
  statusCode,
  objeto
) {

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


function escaparHTML(texto) {

  return String(texto)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

}


function chaveValida(req) {

  const chaveRecebida =
    req.headers["x-send-key"];

  return (
    SEND_KEY &&
    chaveRecebida === SEND_KEY
  );

}


function lerBodyJSON(req) {

  return new Promise(
    (resolve, reject) => {

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

  catch (erro) {

    console.error(
      "Erro ao ler JSON:",
      erro
    );

    return null;

  }

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

      auth: state,

      logger:
        pino({
          level: "silent"
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
      } = update;


      if (
        connection === "open"
      ) {

        conectado = true;

        pairingCode = "";

        status =
          "WhatsApp conectado.";

        console.log(
          "WhatsApp conectado."
        );

      }


      if (
        connection === "close"
      ) {

        conectado = false;

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


        if (!saiuDaConta) {

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
// MERCADO LIVRE - OAUTH / TOKEN
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
      crypto.randomBytes(
        48
      )
    );


  const hash =
    crypto
      .createHash("sha256")
      .update(
        codeVerifier
      )
      .digest();


  const codeChallenge =
    base64URL(hash);


  return {
    codeVerifier,
    codeChallenge
  };

}


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
        method: "POST",

        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded"
        },

        body: params
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


async function renovarTokenMercadoLivre() {

  const tokenAtual =
    lerJSON(
      ML_TOKEN_FILE
    );


  if (
    !tokenAtual?.refresh_token
  ) {

    throw new Error(
      "Refresh token não encontrado."
    );

  }


  const params =
    new URLSearchParams();


  params.set(
    "grant_type",
    "refresh_token"
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
    "refresh_token",
    tokenAtual.refresh_token
  );


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
      "Erro ao renovar token."
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


async function obterTokenMercadoLivre() {

  let token =
    lerJSON(
      ML_TOKEN_FILE
    );


  if (
    !token?.access_token
  ) {

    throw new Error(
      "Mercado Livre não autorizado."
    );

  }


  const margem =
    5 *
    60 *
    1000;


  if (
    token.expira_em &&
    Date.now() >=
      (
        token.expira_em -
        margem
      )
  ) {

    token =
      await renovarTokenMercadoLivre();

  }


  return token.access_token;

}


// ======================================================
// FORMATAÇÃO DE MOEDA
// ======================================================

function formatarReais(valor) {

  return Number(valor)
    .toLocaleString(
      "pt-BR",
      {
        style: "currency",
        currency: "BRL"
      }
    );

}


// ======================================================
// BUSCAR ITENS
// ======================================================

async function buscarProdutos(
  termo,
  accessToken
) {

  const url =
    new URL(
      "https://api.mercadolibre.com/sites/MLB/search"
    );


  url.searchParams.set(
    "q",
    termo
  );


  url.searchParams.set(
    "limit",
    String(
      LIMITE_POR_BUSCA
    )
  );


  const resposta =
    await fetch(
      url,
      {
        headers: {

          Authorization:
            `Bearer ${accessToken}`

        }
      }
    );


  if (!resposta.ok) {

    console.log(
      "Falha ao buscar:",
      termo,
      resposta.status
    );

    return [];

  }


  const dados =
    await resposta.json();


  return (
    dados.results ||
    []
  );

}


// ======================================================
// CONSULTAR PREÇOS DE UM ITEM
// ======================================================

async function consultarPrecos(
  itemId,
  accessToken
) {

  try {

    const resposta =
      await fetch(
        `https://api.mercadolibre.com/items/${itemId}/prices`,
        {
          headers: {

            Authorization:
              `Bearer ${accessToken}`

          }
        }
      );


    if (!resposta.ok) {

      return null;

    }


    return await resposta.json();

  }

  catch {

    return null;

  }

}


// ======================================================
// EXTRAIR PREÇO NORMAL / PROMOCIONAL
// ======================================================

function analisarPrecos(
  dadosPrecos,
  fallbackPrice = null
) {

  if (
    !dadosPrecos?.prices ||
    !Array.isArray(
      dadosPrecos.prices
    )
  ) {

    if (
      fallbackPrice
    ) {

      return {

        original:
          fallbackPrice,

        promocional:
          fallbackPrice,

        desconto:
          0

      };

    }


    return null;

  }


  const precos =
    dadosPrecos.prices;


  let standard =
    precos.find(
      p =>
        p.type ===
        "standard"
    );


  let promotion =
    precos.find(
      p =>
        p.type ===
        "promotion"
    );


  let original = null;
  let promocional = null;


  if (promotion) {

    promocional =
      Number(
        promotion.amount
      );


    if (
      promotion.regular_amount
    ) {

      original =
        Number(
          promotion.regular_amount
        );

    }

  }


  if (
    !original &&
    standard
  ) {

    original =
      Number(
        standard.amount
      );

  }


  if (
    !promocional &&
    standard
  ) {

    promocional =
      Number(
        standard.amount
      );

  }


  if (
    !original &&
    fallbackPrice
  ) {

    original =
      Number(
        fallbackPrice
      );

  }


  if (
    !promocional &&
    fallbackPrice
  ) {

    promocional =
      Number(
        fallbackPrice
      );

  }


  if (
    !original ||
    !promocional
  ) {

    return null;

  }


  let desconto = 0;


  if (
    original >
    promocional
  ) {

    desconto =
      (
        (
          original -
          promocional
        ) /
        original
      ) *
      100;

  }


  return {

    original,

    promocional,

    desconto

  };

}


// ======================================================
// MONTAR MENSAGEM
// ======================================================

function montarMensagemMercadoLivre(
  oferta
) {

  return (
`🔥 OFERTA MERCADO LIVRE 🔥

📦 ${oferta.titulo}

❌ De: ~${formatarReais(oferta.preco_original)}~
💥 Por: ${formatarReais(oferta.preco_promocional)}

Clique aqui
👉 ${oferta.link}`
  );

}


// ======================================================
// CAÇADOR DE OFERTAS
// ======================================================

async function cacarOfertasMercadoLivre(
  quantidade = 20
) {

  const accessToken =
    await obterTokenMercadoLivre();


  const mapa =
    new Map();


  // ------------------------------------------
  // BUSCA EM VÁRIOS TIPOS DE PRODUTO
  // ------------------------------------------

  for (
    const termo of
    BUSCAS_MERCADO_LIVRE
  ) {

    const itens =
      await buscarProdutos(
        termo,
        accessToken
      );


    for (
      const item of itens
    ) {

      if (!item?.id) {
        continue;
      }


      if (
        mapa.has(
          item.id
        )
      ) {
        continue;
      }


      if (
        item.price &&
        Number(item.price) >
        PRECO_MAXIMO
      ) {
        continue;
      }


      mapa.set(
        item.id,
        {

          id:
            item.id,

          titulo:
            item.title,

          link:
            item.permalink,

          imagem:
            item.thumbnail,

          preco_busca:
            item.price,

          vendidos:
            item.sold_quantity ||
            0,

          categoria:
            item.category_id,

          termo_origem:
            termo

        }
      );

    }

  }


  const candidatos =
    Array.from(
      mapa.values()
    );


  console.log(
    "Candidatos encontrados:",
    candidatos.length
  );


  const ofertas =
    [];


  // ------------------------------------------
  // VERIFICA PREÇO PROMOCIONAL
  // ------------------------------------------

  for (
    const item of candidatos
  ) {

    const dadosPrecos =
      await consultarPrecos(
        item.id,
        accessToken
      );


    const preco =
      analisarPrecos(
        dadosPrecos,
        item.preco_busca
      );


    if (!preco) {
      continue;
    }


    if (
      preco.promocional >
      PRECO_MAXIMO
    ) {
      continue;
    }


    if (
      preco.desconto <
      DESCONTO_MINIMO
    ) {
      continue;
    }


    ofertas.push({

      id:
        item.id,

      titulo:
        item.titulo,

      link:
        item.link,

      imagem:
        item.imagem,

      categoria:
        item.categoria,

      termo_origem:
        item.termo_origem,

      vendidos:
        item.vendidos,

      preco_original:
        preco.original,

      preco_promocional:
        preco.promocional,

      desconto:
        Number(
          preco.desconto.toFixed(
            1
          )
        )

    });


    // Evita consultar centenas
    // de produtos desnecessariamente.
    if (
      ofertas.length >=
      quantidade * 4
    ) {

      break;

    }

  }


  // ------------------------------------------
  // RANKING
  // ------------------------------------------

  ofertas.sort(
    (a, b) => {

      // Primeiro desconto
      const diferencaDesconto =
        b.desconto -
        a.desconto;


      if (
        Math.abs(
          diferencaDesconto
        ) > 2
      ) {

        return diferencaDesconto;

      }


      // Em descontos parecidos,
      // prioriza quem já vendeu mais.
      return (
        b.vendidos -
        a.vendidos
      );

    }
  );


  // ------------------------------------------
  // EVITAR REPETIR DEMAIS A MESMA BUSCA
  // ------------------------------------------

  const selecionadas =
    [];


  const contadorTermos =
    new Map();


  for (
    const oferta of ofertas
  ) {

    const termo =
      oferta.termo_origem;


    const quantidadeTermo =
      contadorTermos.get(
        termo
      ) || 0;


    if (
      quantidadeTermo >= 2
    ) {

      continue;

    }


    selecionadas.push(
      oferta
    );


    contadorTermos.set(
      termo,
      quantidadeTermo + 1
    );


    if (
      selecionadas.length >=
      quantidade
    ) {

      break;

    }

  }


  return selecionadas.map(
    oferta => ({

      ...oferta,

      mensagem:
        montarMensagemMercadoLivre(
          oferta
        )

    })
  );

}


// ======================================================
// FORMATAR DESTINO WHATSAPP
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
    String(destino)
      .trim();


  if (
    tipo === "grupo"
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
        req.method === "GET" &&
        caminho === "/status"
      ) {

        const tokenML =
          lerJSON(
            ML_TOKEN_FILE
          );


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
                : "não autorizado"

          }
        );


        return;

      }


      // ==================================================
      // MERCADO LIVRE - LOGIN
      // ==================================================

      if (
        req.method === "GET" &&
        caminho ===
          "/mercadolivre/login"
      ) {

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


        autorizacao.searchParams.set(
          "response_type",
          "code"
        );


        autorizacao.searchParams.set(
          "client_id",
          ML_CLIENT_ID
        );


        autorizacao.searchParams.set(
          "redirect_uri",
          ML_REDIRECT_URI
        );


        autorizacao.searchParams.set(
          "state",
          state
        );


        autorizacao.searchParams.set(
          "code_challenge",
          codeChallenge
        );


        autorizacao.searchParams.set(
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

        return;

      }


      // ==================================================
      // CALLBACK
      // ==================================================

      if (
        req.method === "GET" &&
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
              background:#111;
              color:white;
              font-family:Arial;
              text-align:center;
              padding:60px;
            ">
              <h1>
                ✅ Mercado Livre conectado!
              </h1>

              <p>
                Agora o servidor pode buscar ofertas.
              </p>
            </body>
            `
          );

        }

        catch (erro) {

          responderJSON(
            res,
            500,
            {
              sucesso: false,
              erro: erro.message
            }
          );

        }


        return;

      }


      // ==================================================
      // CAÇADOR DE OFERTAS
      // ==================================================

      if (
        req.method === "GET" &&
        caminho ===
          "/mercadolivre/ofertas"
      ) {

        try {

          let quantidade =
            Number(
              url.searchParams.get(
                "quantidade"
              ) || 10
            );


          if (
            quantidade < 1
          ) {

            quantidade = 1;

          }


          if (
            quantidade > 50
          ) {

            quantidade = 50;

          }


          const ofertas =
            await cacarOfertasMercadoLivre(
              quantidade
            );


          responderJSON(
            res,
            200,
            {

              sucesso:
                true,

              total:
                ofertas.length,

              ofertas:
                ofertas

            }
          );

        }

        catch (erro) {

          console.error(
            "Erro no caçador:",
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
      // GRUPOS
      // ==================================================

      if (
        req.method === "GET" &&
        caminho === "/grupos"
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


          const grupos =
            await sock
              .groupFetchAllParticipating();


          const lista =
            Object.values(
              grupos
            ).map(
              grupo => ({

                nome:
                  grupo.subject,

                id:
                  grupo.id,

                participantes:
                  grupo.participants
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


      // ==================================================
      // SEND
      // ==================================================

      if (
        req.method === "POST" &&
        caminho === "/send"
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


      // ==================================================
      // PÁGINA SIMPLES
      // ==================================================

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
          background:#111;
          color:white;
          font-family:Arial;
          text-align:center;
          padding:50px;
        ">

          <h1>
            Sistema de Ofertas
          </h1>

          <p>
            WhatsApp:
            ${conectado
              ? "✅ conectado"
              : "❌ desconectado"}
          </p>

          <p>
            <a
              href="/mercadolivre/ofertas?quantidade=10"
              style="
                color:#ffe600;
                font-size:20px;
              "
            >
              Procurar 10 ofertas do Mercado Livre
            </a>
          </p>

        </body>
        `
      );

    }
  );


server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `Servidor rodando na porta ${PORT}`
    );

  }
);
