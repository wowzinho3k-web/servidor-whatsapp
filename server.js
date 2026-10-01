import http from "http";
import fs from "fs";

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  Browsers
} from "@whiskeysockets/baileys";

import pino from "pino";

const PORT = process.env.PORT || 3000;
const AUTH_DIR = "/data/baileys-auth";
const SEND_KEY = process.env.SEND_KEY || "";

fs.mkdirSync(AUTH_DIR, { recursive: true });

let sock = null;
let status = "Servidor iniciado. Informe seu número para gerar o código.";
let pairingCode = "";
let conectado = false;


// ======================================================
// PÁGINA PRINCIPAL
// ======================================================

function pagina() {
  return `
    <!DOCTYPE html>
    <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Conectar WhatsApp</title>
      </head>

      <body style="
        background:#111;
        color:white;
        font-family:Arial,sans-serif;
        text-align:center;
        padding:40px;
      ">

        <h1>Conectar WhatsApp</h1>

        <p>${status}</p>

        ${
          pairingCode
            ? `
              <div style="
                font-size:36px;
                font-weight:bold;
                letter-spacing:6px;
                margin:30px;
              ">
                ${pairingCode}
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
              <form method="POST" action="/pair">

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

              <p style="margin-top:25px;">
                Digite somente números:
                55 + DDD + número.
              </p>
            `
        }

        <hr style="
          margin-top:40px;
          border-color:#333;
        ">

        <p>
          Status do WhatsApp:
          <strong>
            ${conectado ? "Conectado" : "Desconectado"}
          </strong>
        </p>

      </body>
    </html>
  `;
}


// ======================================================
// INICIAR WHATSAPP
// ======================================================

async function iniciarWhatsApp() {

  const {
    state,
    saveCreds
  } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    browser: Browsers.ubuntu("Chrome"),
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {

    const {
      connection,
      lastDisconnect
    } = update;

    if (connection === "open") {

      conectado = true;
      pairingCode = "";

      status = "WhatsApp conectado com sucesso!";

      console.log("WhatsApp conectado.");
    }

    if (connection === "close") {

      conectado = false;

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
        statusCode === DisconnectReason.loggedOut;

      if (saiuDaConta) {

        pairingCode = "";

        status =
          "Sessão desconectada. Gere um novo código.";

      } else {

        pairingCode = "";

        status =
          `Conexão caiu. Código: ${
            statusCode ?? "desconhecido"
          }`;

        setTimeout(() => {
          iniciarWhatsApp()
            .catch(console.error);
        }, 5000);

      }

    }

  });

}

await iniciarWhatsApp();


// ======================================================
// AUXILIARES
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


function lerBodyJSON(req) {

  return new Promise(
    (resolve, reject) => {

      let body = "";

      req.on("data", chunk => {
        body += chunk.toString();
      });

      req.on("end", () => {

        try {

          if (!body) {
            resolve({});
            return;
          }

          resolve(
            JSON.parse(body)
          );

        } catch (erro) {

          reject(
            new Error(
              "JSON inválido."
            )
          );

        }

      });

      req.on(
        "error",
        reject
      );

    }
  );

}


function chaveValida(req) {

  const chaveRecebida =
    req.headers["x-send-key"];

  if (!SEND_KEY) {
    return false;
  }

  return chaveRecebida === SEND_KEY;
}


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
    String(destino).trim();

  if (tipo === "grupo") {

    if (
      valor.endsWith("@g.us")
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

  if (numero.length < 10) {

    throw new Error(
      "Número inválido."
    );

  }

  return `${numero}@s.whatsapp.net`;
}


// ======================================================
// SERVIDOR
// ======================================================

const server =
  http.createServer(
    async (req, res) => {


      // ==================================================
      // PAREAR
      // ==================================================

      if (
        req.method === "POST" &&
        req.url === "/pair"
      ) {

        let body = "";

        req.on(
          "data",
          chunk => {
            body += chunk.toString();
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
                params.get("phone") ||
                "";

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

                pairingCode = "";

                res.writeHead(
                  302,
                  {
                    Location: "/"
                  }
                );

                res.end();

                return;

              }

              status =
                "Gerando código de conexão...";

              pairingCode = "";

              const code =
                await sock.requestPairingCode(
                  phone
                );

              pairingCode =
                code;

              status =
                "Código gerado. Digite-o no WhatsApp.";

              res.writeHead(
                302,
                {
                  Location: "/"
                }
              );

              res.end();

            } catch (erro) {

              console.error(
                "Erro ao gerar código:",
                erro
              );

              pairingCode = "";

              status =
                "Erro ao gerar o código. Tente novamente.";

              res.writeHead(
                302,
                {
                  Location: "/"
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
        req.url === "/status"
      ) {

        responderJSON(
          res,
          200,
          {
            servidor: "online",
            whatsapp:
              conectado
                ? "conectado"
                : "desconectado"
          }
        );

        return;
      }


      // ==================================================
      // LISTAR GRUPOS
      // ==================================================

      if (
        req.method === "GET" &&
        req.url === "/grupos"
      ) {

        try {

          if (!chaveValida(req)) {

            responderJSON(
              res,
              401,
              {
                sucesso: false,
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
                sucesso: false,
                erro:
                  "WhatsApp não está conectado."
              }
            );

            return;

          }

          const grupos =
            await sock.groupFetchAllParticipating();

          const lista =
            Object.values(grupos)
              .map(grupo => ({
                nome:
                  grupo.subject ||
                  "Sem nome",
                id:
                  grupo.id,
                participantes:
                  grupo.participants
                    ?.length ||
                  0
              }))
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
              sucesso: true,
              total:
                lista.length,
              grupos:
                lista
            }
          );

        } catch (erro) {

          console.error(
            "Erro ao listar grupos:",
            erro
          );

          responderJSON(
            res,
            500,
            {
              sucesso: false,
              erro:
                erro.message
            }
          );

        }

        return;
      }


      // ==================================================
      // ENVIAR
      // ==================================================

      if (
        req.method === "POST" &&
        req.url === "/send"
      ) {

        try {

          if (!chaveValida(req)) {

            responderJSON(
              res,
              401,
              {
                sucesso: false,
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
                sucesso: false,
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
                sucesso: false,
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

          console.log(
            "Mensagem enviada para:",
            jid
          );

          responderJSON(
            res,
            200,
            {
              sucesso: true,
              destino: jid,
              mensagem:
                "Mensagem enviada com sucesso.",
              id:
                resultado
                  ?.key
                  ?.id ||
                null
            }
          );

        } catch (erro) {

          console.error(
            "Erro no /send:",
            erro
          );

          responderJSON(
            res,
            500,
            {
              sucesso: false,
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
