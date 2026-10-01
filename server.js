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
  "Servidor iniciado. Informe seu número para gerar o código.";

let pairingCode = "";

let conectado = false;


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

  if (!SEND_KEY) {
    return false;
  }

  return chaveRecebida === SEND_KEY;

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
// SALVAR / LER JSON
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
      "Erro ao ler arquivo:",
      arquivo,
      erro
    );

    return null;

  }

}


// ======================================================
// PÁGINA PRINCIPAL
// ======================================================

function pagina() {

  const mlToken =
    lerJSON(
      ML_TOKEN_FILE
    );

  const mercadoLivreConectado =
    Boolean(
      mlToken?.access_token
    );


  return `
    <!DOCTYPE html>

    <html lang="pt-BR">

      <head>

        <meta charset="UTF-8">

        <meta
          name="viewport"
          content="width=device-width, initial-scale=1"
        >

        <title>Servidor de Ofertas</title>

      </head>


      <body style="
        background:#111;
        color:white;
        font-family:Arial,sans-serif;
        text-align:center;
        padding:40px;
        line-height:1.5;
      ">

        <h1>Servidor de Ofertas</h1>


        <div style="
          max-width:650px;
          margin:auto;
          background:#1c1c1c;
          padding:25px;
          border-radius:12px;
          margin-bottom:20px;
        ">

          <h2>WhatsApp</h2>

          <p>
            Status:
            <strong>
              ${
                conectado
                  ? "✅ Conectado"
                  : "❌ Desconectado"
              }
            </strong>
          </p>


          ${
            pairingCode

              ? `

                <div style="
                  font-size:36px;
                  font-weight:bold;
                  letter-spacing:6px;
                  margin:30px;
                ">
                  ${escaparHTML(pairingCode)}
                </div>

                <p>
                  No celular:
                  WhatsApp →
                  Aparelhos conectados →
                  Conectar um aparelho →
                  Conectar com número de telefone
                </p>

              `

              : `

                ${
                  conectado

                    ? `
                      <p>
                        WhatsApp pronto para enviar mensagens.
                      </p>
                    `

                    : `

                      <form
                        method="POST"
                        action="/pair"
                      >

                        <input
                          type="text"
                          name="phone"
                          placeholder="Ex.: 5569999999999"
                          style="
                            padding:12px;
                            font-size:18px;
                            width:260px;
                          "
                          required
                        >

                        <br><br>

                        <button
                          type="submit"
                          style="
                            padding:12px 25px;
                            font-size:18px;
                            cursor:pointer;
                          "
                        >
                          Gerar código
                        </button>

                      </form>

                    `
                }

              `
          }

        </div>


        <div style="
          max-width:650px;
          margin:auto;
          background:#1c1c1c;
          padding:25px;
          border-radius:12px;
        ">

          <h2>Mercado Livre</h2>

          <p>
            Status:
            <strong>
              ${
                mercadoLivreConectado
                  ? "✅ Autorizado"
                  : "❌ Ainda não autorizado"
              }
            </strong>
          </p>


          ${
            mercadoLivreConectado

              ? `

                <p>
                  Mercado Livre conectado ao servidor.
                </p>

                <p>
                  <a
                    href="/mercadolivre/teste"
                    style="
                      color:#ffe600;
                      font-size:18px;
                    "
                  >
                    Testar conexão com Mercado Livre
                  </a>
                </p>

              `

              : `

                <p>
                  <a
                    href="/mercadolivre/login"
                    style="
                      display:inline-block;
                      background:#ffe600;
                      color:#222;
                      padding:12px 22px;
                      border-radius:8px;
                      text-decoration:none;
                      font-weight:bold;
                    "
                  >
                    Conectar Mercado Livre
                  </a>
                </p>

              `
          }

        </div>

      </body>

    </html>
  `;

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
      } = update;


      if (
        connection === "open"
      ) {

        conectado =
          true;

        pairingCode =
          "";

        status =
          "WhatsApp conectado com sucesso!";

        console.log(
          "WhatsApp conectado."
        );

      }


      if (
        connection === "close"
      ) {

        conectado =
          false;

        const statusCode =
          lastDisconnect
            ?.error
            ?.output
            ?.statusCode;


        console.log(
          "Conexão fechada. Código:",
          statusCode
        );


        const saiuDaConta =

          statusCode ===
          DisconnectReason.loggedOut;


        if (
          saiuDaConta
        ) {

          pairingCode =
            "";

          status =
            "Sessão desconectada. Gere um novo código.";

        }

        else {

          pairingCode =
            "";

          status =
            `Conexão caiu. Código: ${
              statusCode ??
              "desconhecido"
            }`;


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


  if (
    numero.length < 10
  ) {

    throw new Error(
      "Número inválido."
    );

  }


  return (
    `${numero}@s.whatsapp.net`
  );

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

          "Accept":
            "application/json",

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

    console.error(
      "Erro OAuth Mercado Livre:",
      dados
    );

    throw new Error(
      dados?.message ||
      dados?.error ||
      "Não foi possível obter o token do Mercado Livre."
    );

  }


  const agora =
    Date.now();


  const tokenCompleto = {

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
    tokenCompleto
  );


  return tokenCompleto;

}


// ======================================================
// MERCADO LIVRE - REFRESH TOKEN
// ======================================================

async function renovarTokenMercadoLivre() {

  const tokenAtual =
    lerJSON(
      ML_TOKEN_FILE
    );


  if (
    !tokenAtual?.refresh_token
  ) {

    throw new Error(
      "Não existe refresh token salvo."
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

          "Accept":
            "application/json",

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
      "Não foi possível renovar o token."
    );

  }


  const agora =
    Date.now();


  const novoToken = {

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
    novoToken
  );


  return novoToken;

}


// ======================================================
// PEGAR TOKEN VÁLIDO
// ======================================================

async function obterTokenMercadoLivre() {

  let token =
    lerJSON(
      ML_TOKEN_FILE
    );


  if (
    !token?.access_token
  ) {

    throw new Error(
      "Mercado Livre ainda não foi autorizado."
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

    console.log(
      "Renovando token do Mercado Livre..."
    );


    token =
      await renovarTokenMercadoLivre();

  }


  return token.access_token;

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

      const url =
        new URL(
          req.url,
          `http://${req.headers.host}`
        );


      const caminho =
        url.pathname;


      // ==================================================
      // PAREAR WHATSAPP
      // ==================================================

      if (
        req.method === "POST" &&
        caminho === "/pair"
      ) {

        let body =
          "";


        req.on(
          "data",
          chunk => {

            body +=
              chunk.toString();

          }
        );


        req.on(
          "end",
          async () => {

            try {

              const params =
                new URLSearchParams(
                  body
                );


              let phone =
                params.get(
                  "phone"
                ) || "";


              phone =
                phone.replace(
                  /\D/g,
                  ""
                );


              if (
                phone.length < 10
              ) {

                status =
                  "Número inválido. Use 55 + DDD + número.";

                pairingCode =
                  "";


                res.writeHead(
                  302,
                  {
                    Location:
                      "/"
                  }
                );

                res.end();

                return;

              }


              status =
                "Gerando código de conexão...";

              pairingCode =
                "";


              const code =
                await sock
                  .requestPairingCode(
                    phone
                  );


              pairingCode =
                code;

              status =
                "Código gerado. Digite-o no WhatsApp.";


              res.writeHead(
                302,
                {
                  Location:
                    "/"
                }
              );

              res.end();

            }

            catch (erro) {

              console.error(
                "Erro ao gerar código:",
                erro
              );


              pairingCode =
                "";

              status =
                "Erro ao gerar o código. Tente novamente.";


              res.writeHead(
                302,
                {
                  Location:
                    "/"
                }
              );

              res.end();

            }

          }
        );


        return;

      }


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
      // LISTAR GRUPOS
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
                  "Chave de acesso inválida."
              }
            );

            return;

          }


          if (
            !sock ||
            !conectado
          ) {

            responderJSON(
              res,
              503,
              {
                sucesso:
                  false,

                erro:
                  "WhatsApp não está conectado."
              }
            );

            return;

          }


          const grupos =
            await sock
              .groupFetchAllParticipating();


          const lista =
            Object
              .values(
                grupos
              )
              .map(
                grupo => ({

                  nome:
                    grupo.subject ||
                    "Sem nome",

                  id:
                    grupo.id,

                  participantes:
                    grupo
                      .participants
                      ?.length ||
                    0

                })
              )
              .sort(
                (a, b) =>
                  a.nome.localeCompare(
                    b.nome
                  )
              );


          responderJSON(
            res,
            200,
            {

              sucesso:
                true,

              total:
                lista.length,

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
      // ENVIAR WHATSAPP
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
                  "Chave de envio inválida."
              }
            );

            return;

          }


          if (
            !sock ||
            !conectado
          ) {

            responderJSON(
              res,
              503,
              {
                sucesso:
                  false,

                erro:
                  "WhatsApp ainda não está conectado."
              }
            );

            return;

          }


          const body =
            await lerBodyJSON(
              req
            );


          const {
            destino,
            mensagem,
            tipo = "numero"
          } = body;


          if (
            !mensagem ||
            !String(
              mensagem
            ).trim()
          ) {

            responderJSON(
              res,
              400,
              {
                sucesso:
                  false,

                erro:
                  "Mensagem vazia."
              }
            );

            return;

          }


          const jid =
            formatarDestino(
              destino,
              tipo
            );


          const resultado =
            await sock.sendMessage(
              jid,
              {
                text:
                  String(
                    mensagem
                  )
              }
            );


          responderJSON(
            res,
            200,
            {

              sucesso:
                true,

              destino:
                jid,

              mensagem:
                "Mensagem enviada com sucesso.",

              id:
                resultado
                  ?.key
                  ?.id ||
                null

            }
          );

        }

        catch (erro) {

          console.error(
            "Erro no /send:",
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
      // MERCADO LIVRE - INICIAR AUTORIZAÇÃO
      // ==================================================

      if (
        req.method === "GET" &&
        caminho === "/mercadolivre/login"
      ) {

        if (
          !ML_CLIENT_ID ||
          !ML_CLIENT_SECRET
        ) {

          responderJSON(
            res,
            500,
            {
              sucesso:
                false,

              erro:
                "ML_CLIENT_ID ou ML_CLIENT_SECRET não configurados."
            }
          );

          return;

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

        return;

      }


      // ==================================================
      // MERCADO LIVRE - CALLBACK
      // ==================================================

      if (
        req.method === "GET" &&
        caminho ===
          "/mercadolivre/callback"
      ) {

        try {

          const erroOAuth =
            url
              .searchParams
              .get(
                "error"
              );


          if (
            erroOAuth
          ) {

            throw new Error(
              `Mercado Livre retornou: ${erroOAuth}`
            );

          }


          const code =
            url
              .searchParams
              .get(
                "code"
              );


          const stateRecebido =
            url
              .searchParams
              .get(
                "state"
              );


          if (!code) {

            throw new Error(
              "O Mercado Livre não retornou o código de autorização."
            );

          }


          const oauthSalvo =
            lerJSON(
              ML_OAUTH_FILE
            );


          if (
            !oauthSalvo ||
            !stateRecebido ||
            stateRecebido !==
              oauthSalvo.state
          ) {

            throw new Error(
              "Falha na validação de segurança do OAuth (state)."
            );

          }


          await trocarCodePorToken(
            code,
            oauthSalvo.codeVerifier
          );


          try {

            fs.unlinkSync(
              ML_OAUTH_FILE
            );

          }

          catch {}


          res.writeHead(
            200,
            {
              "Content-Type":
                "text/html; charset=utf-8"
            }
          );


          res.end(`
            <!DOCTYPE html>

            <html lang="pt-BR">

              <head>
                <meta charset="UTF-8">
                <title>Mercado Livre conectado</title>
              </head>

              <body style="
                background:#111;
                color:white;
                font-family:Arial,sans-serif;
                text-align:center;
                padding:60px;
              ">

                <h1>
                  ✅ Mercado Livre conectado!
                </h1>

                <p>
                  O servidor recebeu e salvou a autorização.
                </p>

                <p>
                  Agora podemos começar a buscar produtos pela API.
                </p>

                <p>
                  <a
                    href="/mercadolivre/teste"
                    style="
                      color:#ffe600;
                      font-size:20px;
                    "
                  >
                    Testar conexão
                  </a>
                </p>

                <p>
                  <a
                    href="/"
                    style="color:white;"
                  >
                    Voltar
                  </a>
                </p>

              </body>

            </html>
          `);

        }

        catch (erro) {

          console.error(
            "Erro no callback do Mercado Livre:",
            erro
          );


          res.writeHead(
            500,
            {
              "Content-Type":
                "text/html; charset=utf-8"
            }
          );


          res.end(`
            <h1>
              Erro ao conectar Mercado Livre
            </h1>

            <p>
              ${escaparHTML(
                erro.message
              )}
            </p>
          `);

        }


        return;

      }


      // ==================================================
      // MERCADO LIVRE - TESTAR TOKEN
      // ==================================================

      if (
        req.method === "GET" &&
        caminho ===
          "/mercadolivre/teste"
      ) {

        try {

          const accessToken =
            await obterTokenMercadoLivre();


          const resposta =
            await fetch(
              "https://api.mercadolibre.com/users/me",
              {

                headers: {

                  Authorization:
                    `Bearer ${accessToken}`

                }

              }
            );


          const dados =
            await resposta.json();


          if (
            !resposta.ok
          ) {

            throw new Error(
              dados?.message ||
              "Erro na API do Mercado Livre."
            );

          }


          responderJSON(
            res,
            200,
            {

              sucesso:
                true,

              mensagem:
                "Mercado Livre conectado corretamente.",

              usuario: {

                id:
                  dados.id,

                apelido:
                  dados.nickname,

                pais:
                  dados.country_id

              }

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
      // PÁGINA PRINCIPAL
      // ==================================================

      res.writeHead(
        200,
        {
          "Content-Type":
            "text/html; charset=utf-8"
        }
      );


      res.end(
        pagina()
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
