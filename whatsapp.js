// whatsapp.js
// Cliente WhatsApp + integração com Google Sheets e Drive.
// Funcionalidades:
// - Em grupos: só responde se for mencionado ou se a mensagem começar com "/"
// - /setup <sheetId|url> | <Project Name>
// - /summary -> resumo do projeto via planilha
// - Upload de anexos -> Google Drive do projeto
//
// Requer: ai.js, sheets.js, drive.js
// Envs: LINKS_DB_PATH, GOOGLE_SA_JSON, OPENAI_API_KEY, ALERT_WEBHOOK_URL

const fs = require("fs");
const path = require("path");
const { Client, LocalAuth } = require("whatsapp-web.js");

const { generateReply } = require("./ai");
const {
  extractSheetId,
  readProjectMeta,
  readTasks,
  buildStatusSummary,
} = require("./sheets");
const { uploadBufferToProject } = require("./drive");

const SESSION_PATH = process.env.WA_SESSION_PATH || "/var/data/wa-session";
const LINKS_DB_PATH = process.env.LINKS_DB_PATH || "/var/data/links-db.json";

const REINIT_COOLDOWN_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 60_000;

let client;
let lastQr = "";
let currentState = "starting";
let reinitNotBefore = 0;

// =============================
// Persistência simples (links grupo -> planilha)
// =============================
function loadLinks() {
  try {
    return JSON.parse(fs.readFileSync(LINKS_DB_PATH, "utf8") || "{}");
  } catch {
    return {};
  }
}
function saveLinks(obj) {
  fs.mkdirSync(path.dirname(LINKS_DB_PATH), { recursive: true });
  fs.writeFileSync(LINKS_DB_PATH, JSON.stringify(obj, null, 2));
}
function resolveProjectLink(chatId) {
  return loadLinks()[chatId] || null;
}
function bindProjectLink(chatId, sheetId, projectName) {
  const db = loadLinks();
  db[chatId] = { sheetId, projectName, updatedAt: Date.now() };
  saveLinks(db);
}

// =============================
// Utilitários
// =============================
function getLastQr() {
  return lastQr;
}

async function sendAlert(payload) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    const body =
      typeof payload === "string" ? { text: payload } : payload || { text: "⚠️ Alerta" };
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("Erro ao enviar alerta:", err);
  }
}

function buildClient() {
  return new Client({
    authStrategy: new LocalAuth({
      clientId: "brynix-bot",
      dataPath: SESSION_PATH,
    }),
    puppeteer: {
      headless: true,
      timeout: 60_000,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--single-process",
      ],
    },
    restartOnAuthFail: true,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 5_000,
  });
}

async function safeReinit(reason = "unknown") {
  const now = Date.now();
  if (now < reinitNotBefore) return;
  reinitNotBefore = now + REINIT_COOLDOWN_MS;

  try {
    if (client) await client.destroy();
  } catch {}
  client = buildClient();
  wireEvents(client);
  client.initialize();
}

async function shouldProcessMessage(msg) {
  const isGroup = msg.from.endsWith("@g.us");
  if (!isGroup) return true;

  const body = (msg.body || "").trim();
  if (body.startsWith("/")) return true;

  try {
    const mentions = await msg.getMentions();
    const myWid = client?.info?.wid?._serialized;
    if (mentions?.some((m) => m?.id?._serialized === myWid)) return true;
  } catch {}
  return false;
}

// =============================
// Eventos
// =============================
function wireEvents(c) {
  c.on("qr", (qr) => {
    lastQr = qr;
    currentState = "qr";
    console.log("[WA] QR gerado");
    sendAlert("🔄 BOT requer novo pareamento. Escaneie o código.");
  });

  c.on("ready", () => {
    currentState = "ready";
    console.log("[WA] Pronto ✅");
    sendAlert("✅ BOT pronto.");
  });

  c.on("auth_failure", (m) => {
    console.error("Falha de auth:", m);
    sendAlert("⚠️ Falha de auth: " + m);
    safeReinit("auth_failure");
  });

  c.on("disconnected", (r) => {
    currentState = "disconnected";
    console.error("Desconectado:", r);
    sendAlert("❌ BOT desconectado: " + r);
    safeReinit("disconnected:" + r);
  });

  // Mensagens
  c.on("message", async (msg) => {
    try {
      if (!(await shouldProcessMessage(msg))) return;

      const body = (msg.body || "").trim();
      const inGroup = msg.from.endsWith("@g.us");

      // --- Comandos ---
      if (body.startsWith("/")) {
        if (body.toLowerCase().startsWith("/help")) {
          await msg.reply(
            "*Comandos*\n" +
              "• /setup <sheetId|url> | <Nome do Projeto>\n" +
              "• /summary → resumo do projeto\n" +
              "• (Envie anexos mencionando o bot ou com /upload)"
          );
          return;
        }

        if (body.toLowerCase().startsWith("/setup")) {
          const [idOrUrl, pNameRaw] = body
            .slice(6)
            .split("|")
            .map((s) => (s || "").trim());
          const sid = extractSheetId(idOrUrl);
          if (!sid) {
            await msg.reply("❌ Use: /setup <sheetId|url> | <Nome>");
            return;
          }
          let projectName = pNameRaw || "";
          try {
            const meta = await readProjectMeta(sid);
            if (!projectName) projectName = meta.ProjectName || "Projeto";
          } catch {}
          bindProjectLink(msg.from, sid, projectName);
          await msg.reply(`✅ Vinculado!\nPlanilha: ${sid}\nNome: ${projectName}`);
          return;
        }

        if (body.toLowerCase().startsWith("/summary")) {
          const link = resolveProjectLink(msg.from);
          if (!link?.sheetId) {
            await msg.reply("❌ Grupo sem planilha vinculada. Use /setup.");
            return;
          }
          const tasks = await readTasks(link.sheetId);
          const resumo = buildStatusSummary(link.projectName, tasks);
          await msg.reply(resumo);
          return;
        }

        if (body.toLowerCase().startsWith("/upload")) {
          if (!msg.hasMedia) {
            await msg.reply("❌ Envie um anexo junto com /upload.");
            return;
          }
          await handleMediaUpload(msg);
          return;
        }

        await msg.reply("🤖 Comando não reconhecido. Use /help.");
        return;
      }

      // --- Upload direto ---
      if (msg.hasMedia) {
        await handleMediaUpload(msg);
        return;
      }

      // --- Conversa IA ---
      const reply = await generateReply(body, {
        from: msg.from,
        pushName: msg._data?.notifyName,
      });
      await msg.reply(reply);
    } catch (err) {
      console.error("Erro handler:", err);
      try {
        await msg.reply("❌ Problema técnico. Pode reenviar?");
      } catch {}
    }
  });

  // Upload helper
  async function handleMediaUpload(msg) {
    try {
      const link = resolveProjectLink(msg.from);
      if (!link?.sheetId) {
        await msg.reply("❌ Grupo sem planilha vinculada. Use /setup.");
        return;
      }
      const meta = await readProjectMeta(link.sheetId);
      const projectName = link.projectName || meta.ProjectName || "Projeto";

      const media = await msg.downloadMedia();
      const buffer = Buffer.from(media.data, "base64");
      const filename = media.filename || `anexo_${Date.now()}`;
      const mime = media.mimetype || "application/octet-stream";

      const uploaded = await uploadBufferToProject(
        buffer,
        filename,
        mime,
        projectName,
        "Anexos"
      );

      await msg.reply(
        `✅ Arquivo salvo em *${projectName}*.\n` +
          `🔗 ${uploaded.webViewLink || uploaded.webContentLink || "Link indisponível"}`
      );
    } catch (e) {
      console.error("Upload falhou:", e);
      await msg.reply("❌ Não consegui salvar no Drive.");
    }
  }
}

// =============================
// Inicialização
// =============================
function initWhatsApp(app) {
  client = buildClient();
  wireEvents(client);

  if (app && app.get) {
    app.get("/wa-status", async (_req, res) => {
      let state = currentState;
      try {
        const s = await client.getState().catch(() => null);
        if (s) state = s;
      } catch {}
      res.json({ status: state });
    });
  }

  client.initialize();

  setInterval(async () => {
    try {
      const s = await client.getState().catch(() => null);
      if (!s || ["CONFLICT", "UNPAIRED", "UNLAUNCHED"].includes(s)) {
        safeReinit("watchdog:" + s);
      }
    } catch (err) {
      safeReinit("watchdog-error");
    }
  }, WATCHDOG_INTERVAL_MS);
}

module.exports = { initWhatsApp, getLastQr, resolveProjectLink };
