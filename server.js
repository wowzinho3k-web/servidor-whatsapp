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

fs.mkdirSync(AUTH_DIR, { recursive: true });

let sock = null;
let status = "Servidor iniciado. Informe seu número para gerar o código.";
let pairingCode = "";

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
                No celular: WhatsApp → Aparelhos conectados →
                Conectar um aparelho → Conectar com número de telefone
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
                Digite somente números: 55 + DDD + número.
              </p>
            `
        }
      </body>
    </html>
  `;
}

async function iniciarWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    browser: Browsers.macOS("Desktop"),
    markOnlineOnConnect: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      pairingCode = "";
      status = "WhatsApp conectado com sucesso!";
      console.log("WhatsApp conectado.");
    }

    if (connection === "close") {
      const statusCode =
        lastDisconnect?.error?.output?.statusCode;

      const saiuDaConta =
        statusCode === DisconnectReason.loggedOut;

      if (saiuDaConta) {
        pairingCode = "";
        status = "Sessão desconectada. Gere um novo código.";
      } else {
        status = "Conexão caiu. Reconectando...";

        setTimeout(() => {
          iniciarWhatsApp().catch(console.error);
        }, 5000);
      }
    }
  });
}

await iniciarWhatsApp();

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/pair") {
    let body = "";

    req.on("data", chunk => {
      body += chunk.toString();
    });

    req.on("end", async () => {
      try {
        const params = new URLSearchParams(body);
        let phone = params.get("phone") || "";

        phone = phone.replace(/\D/g, "");

        if (phone.length < 10) {
          status = "Número inválido. Use 55 + DDD + número.";
          pairingCode = "";

          res.writeHead(302, {
            Location: "/"
          });

          res.end();
          return;
        }

        status = "Gerando código de conexão...";
        pairingCode = "";

        const code = await sock.requestPairingCode(phone);

        pairingCode = code;
        status = "Código gerado. Digite-o no WhatsApp.";

        res.writeHead(302, {
          Location: "/"
        });

        res.end();

      } catch (erro) {
        console.error(erro);

        pairingCode = "";
        status = "Erro ao gerar o código. Tente novamente.";

        res.writeHead(302, {
          Location: "/"
        });

        res.end();
      }
    });

    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8"
  });

  res.end(pagina());
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
