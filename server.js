// Asistente del Hogar por WhatsApp (Cloud API de Meta + Claude)
// Menú y lista del súper + control de gastos + recordatorios + envío de fotos.
// No necesitas modificar este archivo: todo se configura en Railway > Variables.

require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");

const {
  VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  ANTHROPIC_API_KEY,
  BOT_INSTRUCTIONS,
  PORT,
} = process.env;

const MODELO = process.env.CLAUDE_MODEL || "claude-haiku-5-5";
// Diferencia de horas con UTC (México: -6)
const OFFSET_MS = Number(process.env.UTC_OFFSET_HOURS ?? -6) * 3600000;

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------
// Fotos: se guardan en la carpeta /fotos del repositorio y se sirven
// públicamente para que WhatsApp pueda descargarlas.
// ---------------------------------------------------------------------
app.use("/fotos", express.static(path.join(__dirname, "fotos")));
const BASE_URL = process.env.BASE_URL || `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
const FOTOS_DIR = path.join(__dirname, "fotos");
const FOTOS = fs.existsSync(FOTOS_DIR) ? fs.readdirSync(FOTOS_DIR) : [];
const pendientes = {}; // fotos por enviar después de la respuesta de texto

// ---------------------------------------------------------------------
// Datos guardados (gastos, lista del súper, recordatorios) en un archivo
// Para que no se borren al actualizar el bot, agrega un Volume en Railway
// montado en /data y la variable DATA_DIR=/data
// ---------------------------------------------------------------------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "datos.json");
let datos = {};
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) datos = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
} catch (e) {
  console.error("No pude leer los datos guardados:", e.message);
}
function guardar() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(datos));
  } catch (e) {
    console.error("No pude guardar los datos:", e.message);
  }
}
function datosDe(usuario) {
  if (!datos[usuario]) datos[usuario] = { gastos: [], lista: [], recordatorios: [], siguienteId: 1 };
  return datos[usuario];
}

// ---------------------------------------------------------------------
// Fechas (hora local de México)
// ---------------------------------------------------------------------
const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const localDate = (ms = Date.now()) => new Date(ms + OFFSET_MS);
const fechaLocal = (ms = Date.now()) => localDate(ms).toISOString().slice(0, 10);
const formatoLocal = (ms) => {
  const iso = localDate(ms).toISOString();
  return iso.slice(0, 10) + " " + iso.slice(11, 16);
};
function ahoraLocal() {
  const d = localDate();
  return `${DIAS[d.getUTCDay()]} ${formatoLocal(Date.now())}`;
}
function parseLocal(texto) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(texto || "");
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - OFFSET_MS;
}
function siguienteFecha(ms, repetir) {
  const d = localDate(ms);
  const y = d.getUTCFullYear(), mo = d.getUTCMonth(), dia = d.getUTCDate();
  const h = d.getUTCHours(), mi = d.getUTCMinutes();
  let sig;
  if (repetir === "diario") sig = Date.UTC(y, mo, dia + 1, h, mi);
  else if (repetir === "semanal") sig = Date.UTC(y, mo, dia + 7, h, mi);
  else {
    const diasMes = new Date(Date.UTC(y, mo + 2, 0)).getUTCDate();
    sig = Date.UTC(y, mo + 1, Math.min(dia, diasMes), h, mi);
  }
  return sig - OFFSET_MS;
}

// ---------------------------------------------------------------------
// Herramientas que Claude puede usar
// ---------------------------------------------------------------------
const HERRAMIENTAS = [
  {
    name: "registrar_gasto",
    description: "Guarda un gasto del hogar. Úsala cuando la persona diga que gastó o pagó algo.",
    input_schema: {
      type: "object",
      properties: {
        monto: { type: "number", description: "Monto en pesos mexicanos" },
        categoria: { type: "string", description: "super, servicios, transporte, salud, escuela, diversion, hogar u otros" },
        descripcion: { type: "string", description: "Breve descripción, ej. 'tortillas y leche'" },
        fecha: { type: "string", description: "YYYY-MM-DD. Si no la dicen, no la pongas (se usa hoy)." },
      },
      required: ["monto", "categoria"],
    },
  },
  {
    name: "resumen_gastos",
    description: "Devuelve el total gastado y el desglose por categoría de un periodo.",
    input_schema: {
      type: "object",
      properties: { periodo: { type: "string", enum: ["hoy", "semana", "mes"] } },
      required: ["periodo"],
    },
  },
  {
    name: "borrar_ultimo_gasto",
    description: "Elimina el último gasto registrado (por si se equivocó).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "agregar_a_lista",
    description: "Agrega productos a la lista del súper.",
    input_schema: {
      type: "object",
      properties: { items: { type: "array", items: { type: "string" } } },
      required: ["items"],
    },
  },
  {
    name: "ver_lista",
    description: "Muestra los productos de la lista del súper.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "quitar_de_lista",
    description: "Quita productos de la lista del súper (ya comprados) o la vacía por completo.",
    input_schema: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "string" } },
        limpiar_todo: { type: "boolean" },
      },
    },
  },
  {
    name: "crear_recordatorio",
    description: "Crea un recordatorio que se enviará por WhatsApp a la hora indicada. Convierte expresiones como 'mañana a las 5' usando la fecha y hora actual.",
    input_schema: {
      type: "object",
      properties: {
        texto: { type: "string", description: "Qué hay que recordar" },
        fecha_hora: { type: "string", description: "Hora local de México en formato YYYY-MM-DD HH:MM" },
        repetir: { type: "string", enum: ["ninguno", "diario", "semanal", "mensual"] },
      },
      required: ["texto", "fecha_hora"],
    },
  },
  {
    name: "ver_recordatorios",
    description: "Lista los recordatorios pendientes.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "borrar_recordatorio",
    description: "Elimina un recordatorio por su id.",
    input_schema: {
      type: "object",
      properties: { id: { type: "number" } },
      required: ["id"],
    },
  },
  {
    name: "enviar_foto",
    description: "Envía una foto al usuario. Fotos disponibles: " + (FOTOS.join(", ") || "ninguna"),
    input_schema: {
      type: "object",
      properties: {
        archivo: { type: "string", description: "Nombre exacto del archivo" },
        descripcion: { type: "string", description: "Texto corto que acompaña la foto" },
      },
      required: ["archivo"],
    },
  },
];

function ejecutarHerramienta(usuario, nombre, entrada) {
  try {
    const d = datosDe(usuario);
    switch (nombre) {
      case "registrar_gasto": {
        const monto = Number(entrada.monto);
        if (!(monto > 0)) return { error: "El monto debe ser mayor a 0" };
        const gasto = {
          monto,
          categoria: (entrada.categoria || "otros").toLowerCase(),
          descripcion: entrada.descripcion || "",
          fecha: /^\d{4}-\d{2}-\d{2}$/.test(entrada.fecha || "") ? entrada.fecha : fechaLocal(),
        };
        d.gastos.push(gasto);
        guardar();
        const mes = fechaLocal().slice(0, 7);
        const totalMes = d.gastos.filter((g) => g.fecha.startsWith(mes)).reduce((s, g) => s + g.monto, 0);
        return { ok: true, gasto, total_del_mes: totalMes };
      }
      case "resumen_gastos": {
        const hoy = fechaLocal();
        let filtro;
        if (entrada.periodo === "hoy") filtro = (g) => g.fecha === hoy;
        else if (entrada.periodo === "semana") {
          const inicio = fechaLocal(Date.now() - 6 * 86400000);
          filtro = (g) => g.fecha >= inicio && g.fecha <= hoy;
        } else filtro = (g) => g.fecha.startsWith(hoy.slice(0, 7));
        const lista = d.gastos.filter(filtro);
        const porCategoria = {};
        lista.forEach((g) => (porCategoria[g.categoria] = (porCategoria[g.categoria] || 0) + g.monto));
        return {
          periodo: entrada.periodo,
          total: lista.reduce((s, g) => s + g.monto, 0),
          num_gastos: lista.length,
          por_categoria: porCategoria,
          ultimos: lista.slice(-5),
        };
      }
      case "borrar_ultimo_gasto": {
        const g = d.gastos.pop();
        guardar();
        return g ? { ok: true, borrado: g } : { error: "No hay gastos registrados" };
      }
      case "agregar_a_lista": {
        const nuevos = (entrada.items || []).map((i) => String(i).trim()).filter(Boolean);
        nuevos.forEach((i) => {
          if (!d.lista.some((x) => x.toLowerCase() === i.toLowerCase())) d.lista.push(i);
        });
        guardar();
        return { ok: true, lista: d.lista };
      }
      case "ver_lista":
        return { lista: d.lista };
      case "quitar_de_lista": {
        if (entrada.limpiar_todo) d.lista = [];
        else {
          const quitar = (entrada.items || []).map((i) => String(i).toLowerCase().trim());
          d.lista = d.lista.filter((x) => !quitar.some((q) => q && x.toLowerCase().includes(q)));
        }
        guardar();
        return { ok: true, lista: d.lista };
      }
      case "crear_recordatorio": {
        const cuando = parseLocal(entrada.fecha_hora);
        if (!cuando) return { error: "Fecha inválida, usa YYYY-MM-DD HH:MM" };
        if (cuando < Date.now() - 60000) return { error: "Esa fecha y hora ya pasaron" };
        const r = {
          id: d.siguienteId++,
          texto: entrada.texto,
          cuandoMs: cuando,
          repetir: entrada.repetir || "ninguno",
          intentos: 0,
        };
        d.recordatorios.push(r);
        guardar();
        return { ok: true, id: r.id, para: formatoLocal(cuando), repetir: r.repetir };
      }
      case "ver_recordatorios":
        return {
          recordatorios: d.recordatorios.map((r) => ({
            id: r.id,
            texto: r.texto,
            para: formatoLocal(r.cuandoMs),
            repetir: r.repetir,
          })),
        };
      case "borrar_recordatorio": {
        const antes = d.recordatorios.length;
        d.recordatorios = d.recordatorios.filter((r) => r.id !== entrada.id);
        guardar();
        return d.recordatorios.length < antes ? { ok: true } : { error: "No encontré ese recordatorio" };
      }
      case "enviar_foto": {
        if (!FOTOS.includes(entrada.archivo)) return { error: "Esa foto no existe", disponibles: FOTOS };
        (pendientes[usuario] = pendientes[usuario] || []).push({
          archivo: entrada.archivo,
          caption: entrada.descripcion || "",
        });
        return { ok: true };
      }
      default:
        return { error: "Herramienta desconocida" };
    }
  } catch (e) {
    console.error("Error en herramienta", nombre, e);
    return { error: "Falló la herramienta" };
  }
}

// ---------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------
function instrucciones() {
  return `Eres "Asistente del Hogar", un asistente por WhatsApp para amas de casa en México.
Fecha y hora actual: ${ahoraLocal()} (hora de México). Moneda: pesos mexicanos.

Ayudas con tres cosas:
1) MENÚ Y LISTA DEL SÚPER: sugiere menús y recetas sencillas y económicas. Si falta el presupuesto, cuántas personas son o alguna restricción, pregunta solo lo más importante (una pregunta). Ofrece pasar los ingredientes a la lista del súper y usa las herramientas de la lista.
2) GASTOS: cuando digan que gastaron algo, usa registrar_gasto y confirma con el total del mes. Para resúmenes usa resumen_gastos y da el total y el desglose por categoría.
3) RECORDATORIOS: pagos de luz, agua, colegiaturas, citas, cumpleaños. Usa crear_recordatorio con la fecha y hora exacta. Si no dicen la hora, pregúntala. Confirma diciendo cuándo se enviará.

4) FOTOS: si la persona manda una foto de comida, di qué platillo parece y lista los ingredientes principales (con cantidades aproximadas si puedes). Aclara que es una estimación y ofrece agregar los ingredientes a la lista del súper. Si la foto no es de comida, describe brevemente lo que ves y pregunta en qué la puedes ayudar.

Reglas: responde siempre en español, con mensajes cortos y claros al estilo WhatsApp. Usa *negritas* con un solo asterisco y pocos emojis. No uses encabezados ni tablas. Usa siempre las herramientas para guardar o consultar datos; nunca inventes montos, listas ni recordatorios. No des consejos médicos ni financieros profesionales. Nunca pidas contraseñas ni datos bancarios.

${BOT_INSTRUCTIONS || ""}`;
}

const historial = {};

async function llamarClaude(mensajes) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODELO,
      max_tokens: 700,
      system: instrucciones(),
      tools: HERRAMIENTAS,
      messages: mensajes,
    }),
  });
  const data = await r.json();
  if (!r.ok) {
    console.error("Error de Claude:", JSON.stringify(data));
    return null;
  }
  return data;
}

async function generarRespuesta(usuario, texto, imagen) {
  if (!ANTHROPIC_API_KEY) return `Recibí tu mensaje: "${texto}"`;
  const hist = (historial[usuario] = historial[usuario] || []);
  // En el historial solo se guarda texto (las fotos pesan mucho)
  hist.push({ role: "user", content: imagen ? `[Foto enviada] ${texto}` : texto });
  const mensajes = hist.slice(-12);
  while (mensajes.length && mensajes[0].role !== "user") mensajes.shift();
  if (imagen) {
    mensajes[mensajes.length - 1] = {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: imagen.media_type, data: imagen.data } },
        { type: "text", text: texto },
      ],
    };
  }

  let textoFinal = "";
  for (let vuelta = 0; vuelta < 6; vuelta++) {
    const data = await llamarClaude(mensajes);
    if (!data) return "Lo siento, tuve un problema para responder. Intenta de nuevo en un momento.";
    mensajes.push({ role: "assistant", content: data.content });
    const usos = data.content.filter((b) => b.type === "tool_use");
    if (data.stop_reason === "tool_use" && usos.length) {
      const resultados = usos.map((u) => ({
        type: "tool_result",
        tool_use_id: u.id,
        content: JSON.stringify(ejecutarHerramienta(usuario, u.name, u.input || {})),
      }));
      mensajes.push({ role: "user", content: resultados });
      continue;
    }
    textoFinal = data.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    break;
  }
  textoFinal = textoFinal || "Listo ✅";
  hist.push({ role: "assistant", content: textoFinal });
  historial[usuario] = hist.slice(-12);
  return textoFinal;
}

// ---------------------------------------------------------------------
// WhatsApp
// ---------------------------------------------------------------------
async function enviar(para, texto) {
  // México: WhatsApp entrega el número como 521XXXXXXXXXX pero la API
  // lo espera como 52XXXXXXXXXX. Se quita el "1" para que coincida.
  if (/^521\d{10}$/.test(para)) para = "52" + para.slice(3);
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
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
    });
    if (!r.ok) {
      console.error("Error al enviar:", await r.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error("Error al enviar:", e.message);
    return false;
  }
}

// Enviar una foto (la imagen debe estar en la carpeta /fotos del repositorio)
async function enviarFoto(para, archivo, caption) {
  if (/^521\d{10}$/.test(para)) para = "52" + para.slice(3);
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: para,
        type: "image",
        image: { link: `${BASE_URL}/fotos/${encodeURIComponent(archivo)}`, caption: caption || "" },
      }),
    });
    if (!r.ok) console.error("Error al enviar foto:", await r.text());
  } catch (e) {
    console.error("Error al enviar foto:", e.message);
  }
}

// Descarga una foto que mandó el usuario y la deja lista para Claude
async function descargarImagen(mediaId) {
  const h = { Authorization: `Bearer ${WHATSAPP_TOKEN}` };
  const meta = await (await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, { headers: h })).json();
  if (!meta.url) throw new Error("Meta no devolvió la URL de la imagen: " + JSON.stringify(meta));
  const r = await fetch(meta.url, { headers: h });
  if (!r.ok) throw new Error("No pude descargar la imagen: " + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  return { media_type: meta.mime_type || "image/jpeg", data: buf.toString("base64") };
}

// Meta llama aquí para verificar que el webhook es tuyo
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

// Suscribe tu cuenta de WhatsApp Business a esta app (necesario para recibir mensajes reales)
// Uso: abre en el navegador /suscribir?clave=TU_VERIFY_TOKEN
app.get("/suscribir", async (req, res) => {
  if (req.query.clave !== VERIFY_TOKEN) return res.sendStatus(403);
  const waba = process.env.WABA_ID || "2571359863363370";
  const r = await fetch(`https://graph.facebook.com/v21.0/${waba}/subscribed_apps`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  const texto = await r.text();
  console.log("Suscripción:", texto);
  res.send(`Respuesta de Meta: ${texto}`);
});

// Para no responder dos veces si Meta reenvía un mensaje
const vistos = new Set();

app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Responder rápido a Meta
  try {
    const mensaje = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!mensaje) return; // eventos que no son mensajes (estados, etc.)
    if (vistos.has(mensaje.id)) return;
    vistos.add(mensaje.id);
    if (vistos.size > 500) vistos.clear();

    const de = mensaje.from;
    let texto;
    let imagen = null;
    if (mensaje.type === "image") {
      texto = mensaje.image.caption || "Dime qué hay en esta foto. Si es comida, dime los ingredientes.";
      try {
        imagen = await descargarImagen(mensaje.image.id);
      } catch (e) {
        console.error("Error con la foto:", e.message);
        await enviar(de, "No pude abrir la foto, intenta mandarla de nuevo 🙏");
        return;
      }
    } else if (mensaje.type === "text") {
      texto = mensaje.text.body;
    } else {
      await enviar(de, "Por ahora solo entiendo mensajes de texto y fotos 🙂");
      return;
    }
    console.log(`Mensaje de ${de}: ${texto}${imagen ? " (con foto)" : ""}`);
    const respuesta = await generarRespuesta(de, texto, imagen);
    await enviar(de, respuesta);
    // Fotos que Claude pidió enviar
    for (const f of pendientes[de] || []) await enviarFoto(de, f.archivo, f.caption);
    pendientes[de] = [];
  } catch (err) {
    console.error("Error:", err);
  }
});

// ---------------------------------------------------------------------
// Envío de recordatorios (revisa cada 30 segundos)
// Nota: WhatsApp solo permite mensajes libres dentro de las 24 h
// posteriores al último mensaje de la persona.
// ---------------------------------------------------------------------
setInterval(async () => {
  const ahora = Date.now();
  let cambio = false;
  for (const [usuario, d] of Object.entries(datos)) {
    for (const r of [...d.recordatorios]) {
      if (r.cuandoMs > ahora) continue;
      const ok = await enviar(usuario, `⏰ *Recordatorio:* ${r.texto}`);
      cambio = true;
      if (!ok && (r.intentos || 0) < 2) {
        r.intentos = (r.intentos || 0) + 1;
        r.cuandoMs = ahora + 10 * 60000; // reintentar en 10 min
        continue;
      }
      if (r.repetir && r.repetir !== "ninguno") {
        let sig = siguienteFecha(r.cuandoMs, r.repetir);
        while (sig <= ahora) sig = siguienteFecha(sig, r.repetir);
        r.cuandoMs = sig;
        r.intentos = 0;
      } else {
        d.recordatorios = d.recordatorios.filter((x) => x.id !== r.id);
      }
    }
  }
  if (cambio) guardar();
}, 30000);

// ---------------------------------------------------------------------
app.get("/", (req, res) => res.send("El bot está funcionando ✅"));

// Página de política de privacidad (Meta la pide para publicar la app)
app.get("/privacidad", (req, res) => {
  const correo = process.env.CONTACT_EMAIL || "tu-correo@ejemplo.com";
  res.send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Política de Privacidad - Asistente del Hogar</title>
<style>body{font-family:Arial,sans-serif;max-width:700px;margin:40px auto;padding:0 16px;line-height:1.6;color:#222}</style>
</head><body>
<h1>Política de Privacidad</h1>
<p>Última actualización: octubre de 2026.</p>
<p>Asistente del Hogar es un asistente automático que responde mensajes por WhatsApp para ayudar con menús, lista del súper, gastos del hogar y recordatorios. Es un proyecto escolar con fines educativos.</p>
<h2>Qué datos recopilamos</h2>
<p>Tu número de teléfono, el contenido de tus mensajes y la información que nos pides guardar: gastos, productos de tu lista del súper y recordatorios.</p>
<h2>Cómo usamos tus datos</h2>
<p>Los usamos solo para responderte y darte el servicio solicitado. Podemos usar servicios de inteligencia artificial de terceros para procesar tus mensajes. No vendemos ni compartimos tus datos con fines publicitarios.</p>
<h2>Eliminación de datos</h2>
<p>Puedes pedir que borremos tu información escribiendo a: <a href="mailto:${correo}">${correo}</a></p>
<h2>Contacto</h2>
<p>Para cualquier duda sobre esta política: ${correo}</p>
</body></html>`);
});

app.listen(PORT || 3000, () => console.log(`Servidor listo en el puerto ${PORT || 3000}`));
