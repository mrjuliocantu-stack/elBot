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

// Página de política de privacidad (Meta la pide para publicar la app)
app.get("/privacidad", (req, res) => {
  const correo = process.env.CONTACT_EMAIL || "tu-correo@ejemplo.com";
  res.send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Política de Privacidad - ELbot</title>
<style>body{font-family:Arial,sans-serif;max-width:700px;margin:40px auto;padding:0 16px;line-height:1.6;color:#222}</style>
</head><body>
<h1>Política de Privacidad</h1>
<p>Última actualización: octubre de 2026.</p>
<p>ELbot es un asistente automático que responde mensajes por WhatsApp.</p>
<h2>Qué datos recopilamos</h2>
<p>Únicamente tu número de teléfono y el contenido de los mensajes que nos envías, con el fin de poder responderte.</p>
<h2>Cómo usamos tus datos</h2>
<p>Usamos tus mensajes solo para generar respuestas. Podemos usar servicios de inteligencia artificial de terceros para procesarlos. No vendemos ni compartimos tus datos con fines publicitarios.</p>
<h2>Conservación</h2>
<p>Las conversaciones se guardan temporalmente en memoria y se eliminan cuando el servicio se reinicia.</p>
<h2>Eliminación de datos</h2>
<p>Puedes solicitar la eliminación de tus datos escribiendo a: <a href="mailto:${correo}">${correo}</a></p>
<h2>Contacto</h2>
<p>Para cualquier duda sobre esta política: ${correo}</p>
</body></html>`);
});

app.listen(PORT || 3000, () =>
  console.log(`Servidor listo en el puerto ${PORT || 3000}`)
);
