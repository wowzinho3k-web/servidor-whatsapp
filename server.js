import http from "http";
import fs from "fs";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import pino from "pino";

const PORT = process.env.PORT || 3000;
const AUTH_DIR = "/data/baileys-auth";

fs.mkdirSync(AUTH_DIR, { recursive: true });

let status = "Iniciando conexão com o WhatsApp...";
let qrImage = null;

async function iniciarWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    markOnlineOnConnect: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrImage = await QRCode.toDataURL(qr);
      status = "Escaneie o QR Code com o WhatsApp";
    }

    if (connection === "open") {
      qrImage = null;
      status = "WhatsApp conectado com sucesso!";
      console.log("WhatsApp conectado.");
    }

    if (connection === "close") {
      const statusCode =
        lastDisconnect?.error?.output?.statusCode;

      const desconectado =
        statusCode === DisconnectReason.loggedOut;

      if (desconectado) {
        qrImage = null;
        status = "Sessão desconectada. Será necessário conectar novamente.";
      } else {
        status = "Conexão caiu. Reconectando...";
        setTimeout(iniciarWhatsApp, 3000);
      }
    }
  });
}

iniciarWhatsApp().catch((erro) => {
  console.error(erro);
  status = "Erro ao iniciar o WhatsApp.";
});

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8"
  });

  res.end(`
    <!DOCTYPE html>
    <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="refresh" content="5">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Servidor WhatsApp</title>
      </head>
      <body style="
        background:#111;
        color:white;
        font-family:Arial,sans-serif;
        text-align:center;
        padding:40px;
      ">
        <h1>Servidor WhatsApp</h1>
        <h2>${status}</h2>

        ${
          qrImage
            ? `<img
                src="${qrImage}"
                alt="QR Code WhatsApp"
                style="max-width:320px;background:white;padding:15px;"
              >`
            : ""
        }

        <p>A página atualiza automaticamente a cada 5 segundos.</p>
      </body>
    </html>
  `);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
