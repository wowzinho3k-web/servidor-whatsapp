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
// IMPORTANTE PARA A EXTENSÃO DO CHROME
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
// CHAVE DE SEGURANÇA
// ======================================================

function chaveValida(req) {

  const chaveRecebida =
    req.headers["x-send-key"];

  return (
    SEND_KEY &&
    chaveRecebida === SEND_KEY
  );

}


// ======================================================
// LER BODY JSON
// ======================================================

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
// FILA DE OFERTAS
// ======================================================

function carregarFila() {

  const fila =
    lerJSON(
      FILA_FILE
    );


  if (
    !Array.isArray(
      fila
    )
  ) {

    return [];

  }


  return fila;

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
      oferta?.titulo || ""
    ).trim();


  const link =
    String(
      oferta?.link || ""
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
        "mercadolivre"
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
        : (
            oferta.preco_original
              ? String(
                  oferta.preco_original
                )
              : null
          ),

    preco_original_numerico:
      Number(
        oferta.precoOriginalNumerico ||
        oferta.preco_original_numerico ||
        0
      ),

    ordem_original:
      Number(
        oferta.ordem ||
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
// MERCADO LIVRE - TROCAR CODE POR TOKEN
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
// FORMATAR DESTINO WHATSAPP
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
    )
      .trim();


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


      // ==================================================
      // PREFLIGHT DA EXTENSÃO
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
              "ML_CLIENT_ID ou ML_CLIENT_SECRET não configurado."
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
                Autorização concluída.
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
      // FILA - VER
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
      // FILA - ADICIONAR OFERTAS
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


          const chavesExistentes =
            new Set();


          for (
            const item of fila
          ) {

            if (
              item.produto_id
            ) {

              chavesExistentes.add(
                `id:${item.produto_id}`
              );

            }


            if (
              item.link
            ) {

              chavesExistentes.add(
                `link:${item.link}`
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
                ? `id:${oferta.produto_id}`
                : null;


            const chaveLink =
              `link:${oferta.link}`;


            if (
              (
                chaveId &&
                chavesExistentes.has(
                  chaveId
                )
              ) ||
              chavesExistentes.has(
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

              chavesExistentes.add(
                chaveId
              );

            }


            chavesExistentes.add(
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
                fila.length,

              pendentes:
                fila.filter(
                  item =>
                    item.status ===
                    "pendente"
                ).length

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
      // FILA - LIMPAR
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
              "WhatsApp não está conectado."
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
              "WhatsApp não está conectado."
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
            🤖 Sistema Achadinhos
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
            Ofertas na fila:
            <strong>
              ${fila.length}
            </strong>
          </p>

          <p>
            Pendentes:
            <strong>
              ${
                fila.filter(
                  item =>
                    item.status ===
                    "pendente"
                ).length
              }
            </strong>
          </p>

          <p style="
            color:#94a3b8;
            margin-top:30px;
          ">
            Servidor pronto para receber ofertas
            da extensão Achadinhos Automático.
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
