// Bot de WhatsApp (Cloud API de Meta) con respuestas opcionales de Claude.
// No necesitas modificar este archivo: todo se configura en el archivo .env

require("dotenv").config();
const express = require("express");

const {
  VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  ANTHROPIC_API_KEY,
  BOT_INSTRUCTIONS,
  PORT,
} = process.env;

const app = express();
app.use(express.json());

// Memoria corta de conversación por usuario (se borra al reiniciar)
const historial = {};

// 1) Meta llama aquí para verificar que el webhook es tuyo
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// 2) Meta envía aquí cada mensaje que recibes
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Responder rápido a Meta

  try {
    const mensaje =
      req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!mensaje) return; // eventos que no son mensajes (estados, etc.)

    const de = mensaje.from;

    if (mensaje.type !== "text") {
      await enviar(de, "Por ahora solo entiendo mensajes de texto 🙂");
      return;
    }

    const texto = mensaje.text.body;
    console.log(`Mensaje de ${de}: ${texto}`);

    const respuesta = await generarRespuesta(de, texto);
    await enviar(de, respuesta);
  } catch (err) {
    console.error("Error:", err);
  }
});

// Genera la respuesta: con Claude si hay clave, si no repite el mensaje
async function generarRespuesta(usuario, texto) {
  if (!ANTHROPIC_API_KEY) {
    return `Recibí tu mensaje: "${texto}"`;
  }

  historial[usuario] = historial[usuario] || [];
  historial[usuario].push({ role: "user", content: texto });
  historial[usuario] = historial[usuario].slice(-10); // últimos 10 mensajes

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-5-5",
      max_tokens: 500,
      system:
        BOT_INSTRUCTIONS ||
        "Eres un asistente amable. Responde en español, de forma breve y clara.",
      messages: historial[usuario],
    }),
  });

  const data = await r.json();
  if (!r.ok) {
    console.error("Error de Claude:", data);
    return "Lo siento, tuve un problema para responder. Intenta de nuevo.";
  }

  const respuesta = data.content.map((b) => b.text || "").join("");
  historial[usuario].push({ role: "assistant", content: respuesta });
  return respuesta;
}

// Envía un mensaje de WhatsApp
async function enviar(para, texto) {
  const r = await fetch(
    `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: para,
        type: "text",
        text: { body: texto },
      }),
    }
  );
  if (!r.ok) console.error("Error al enviar:", await r.text());
}

app.get("/", (req, res) => res.send("El bot está funcionando ✅"));

app.listen(PORT || 3000, () =>
  console.log(`Servidor listo en el puerto ${PORT || 3000}`)
);
