require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const VOICEFLOW_API_URL =
  process.env.VOICEFLOW_API_URL || 'https://general-runtime.voiceflow.com';
const VOICEFLOW_API_KEY = process.env.VOICEFLOW_API_KEY;
const VOICEFLOW_VERSION_ID = process.env.VOICEFLOW_VERSION_ID || 'main';

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'pedidos.json');
const TMP_FILE = path.join(DATA_DIR, 'pedidos.tmp.json');
const USAGE_FILE = path.join(DATA_DIR, 'voiceflow-usage.json');
const USAGE_TMP_FILE = path.join(DATA_DIR, 'voiceflow-usage.tmp.json');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const AUDIT_STORE_TEXT = process.env.AUDIT_STORE_TEXT === 'true';

// Retención de pedidos en disco: limpieza periódica de los "listos" antiguos
// para que `pedidos.json` no crezca de forma indefinida.
const RETENCION_LISTOS_MS =
  Number(process.env.RETENCION_LISTOS_MS) || 24 * 60 * 60 * 1000; // 24h
const LIMPIEZA_INTERVALO_MS =
  Number(process.env.LIMPIEZA_INTERVALO_MS) || 60 * 60 * 1000; // 1h

// Rate limit muy básico (sin dependencias): nº máximo de POST/PATCH/DELETE
// por IP en una ventana corta. Suficiente para un piloto en restaurante.
const RATE_LIMIT_WINDOW_MS =
  Number(process.env.RATE_LIMIT_WINDOW_MS) || 10 * 1000; // 10s
const RATE_LIMIT_MAX =
  Number(process.env.RATE_LIMIT_MAX) || 30; // 30 req/10s por IP

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

if (!VOICEFLOW_API_KEY) {
  console.error('Falta VOICEFLOW_API_KEY en las variables de entorno.');
  process.exit(1);
}

if (allowedOrigins.length === 0) {
  console.warn(
    'ALLOWED_ORIGINS vacío: CORS permitirá cualquier origen. Configura el dominio de Netlify en producción.'
  );
}

/* =============================================================
 * PERSISTENCIA EN DISCO
 * Almacena los pedidos en data/pedidos.json. En Railway, montar
 * un Volume sobre /app/data (o usar DATA_DIR) para no perderlos.
 * ============================================================= */

const ESTADOS = ['pendiente', 'en_preparacion', 'listo'];
const ESTADOS_ACTIVOS = ['pendiente', 'en_preparacion'];
// Estados antiguos que se mapean a los nuevos para retrocompatibilidad
const ALIAS_ESTADOS = {
  preparando: 'en_preparacion',
  'en-preparacion': 'en_preparacion',
  preparacion: 'en_preparacion',
  ready: 'listo',
  done: 'listo',
};

function normalizarEstado(estado) {
  if (typeof estado !== 'string') return null;
  const limpio = estado.trim().toLowerCase();
  if (ESTADOS.includes(limpio)) return limpio;
  if (ALIAS_ESTADOS[limpio]) return ALIAS_ESTADOS[limpio];
  return null;
}

let pedidos = [];
let pedidoSeq = 0;
let voiceflowUsage = [];
let saveTimer = null;
let saving = false;
let pendingSave = false;
let usageSaveTimer = null;
let usageSaving = false;
let usagePendingSave = false;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function cargarPedidos() {
  try {
    ensureDataDir();
    if (!fs.existsSync(DATA_FILE)) {
      pedidos = [];
      pedidoSeq = 0;
      return;
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    if (!raw.trim()) {
      pedidos = [];
      pedidoSeq = 0;
      return;
    }
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      pedidos = data;
      pedidoSeq = pedidos.reduce(
        (max, p) => Math.max(max, Number(p.id) || 0),
        0
      );
    } else if (data && Array.isArray(data.pedidos)) {
      pedidos = data.pedidos;
      pedidoSeq = Number(data.seq) || 0;
      pedidos.forEach((p) => {
        pedidoSeq = Math.max(pedidoSeq, Number(p.id) || 0);
      });
    }
    // Migración suave: aplica nuevos campos por defecto
    pedidos = pedidos.map((p) => ({
      ...p,
      estado: normalizarEstado(p.estado) || 'pendiente',
      historial: Array.isArray(p.historial) ? p.historial : [],
      updatedAt: p.updatedAt || p.createdAt || Date.now(),
    }));
    console.log(
      `Pedidos cargados desde disco: ${pedidos.length} (seq=${pedidoSeq})`
    );
  } catch (err) {
    console.error('No se pudieron cargar los pedidos:', err);
    pedidos = [];
    pedidoSeq = 0;
  }
}

function cargarVoiceflowUsage() {
  try {
    ensureDataDir();
    if (!fs.existsSync(USAGE_FILE)) {
      voiceflowUsage = [];
      return;
    }
    const raw = fs.readFileSync(USAGE_FILE, 'utf8');
    voiceflowUsage = raw.trim() ? JSON.parse(raw) : [];
    if (!Array.isArray(voiceflowUsage)) voiceflowUsage = [];
    console.log(`Auditoría Voiceflow cargada: ${voiceflowUsage.length} registros`);
  } catch (err) {
    console.error('No se pudo cargar la auditoría Voiceflow:', err);
    voiceflowUsage = [];
  }
}

async function escribirAtomico() {
  ensureDataDir();
  const payload = JSON.stringify(
    { seq: pedidoSeq, pedidos },
    null,
    2
  );
  await fs.promises.writeFile(TMP_FILE, payload, 'utf8');
  await fs.promises.rename(TMP_FILE, DATA_FILE);
}

async function escribirUsageAtomico() {
  ensureDataDir();
  const payload = JSON.stringify(voiceflowUsage, null, 2);
  await fs.promises.writeFile(USAGE_TMP_FILE, payload, 'utf8');
  await fs.promises.rename(USAGE_TMP_FILE, USAGE_FILE);
}

async function guardarPedidos() {
  if (saving) {
    pendingSave = true;
    return;
  }
  saving = true;
  try {
    await escribirAtomico();
  } catch (err) {
    console.error('Error guardando pedidos:', err);
  } finally {
    saving = false;
    if (pendingSave) {
      pendingSave = false;
      // Encadena otra escritura si llegaron cambios mientras guardaba
      guardarPedidos();
    }
  }
}

async function guardarVoiceflowUsage() {
  if (usageSaving) {
    usagePendingSave = true;
    return;
  }
  usageSaving = true;
  try {
    await escribirUsageAtomico();
  } catch (err) {
    console.error('Error guardando auditoría Voiceflow:', err);
  } finally {
    usageSaving = false;
    if (usagePendingSave) {
      usagePendingSave = false;
      guardarVoiceflowUsage();
    }
  }
}

function programarGuardado() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    guardarPedidos();
  }, 150); // pequeño debounce para agrupar escrituras
}

function programarGuardadoUsage() {
  if (usageSaveTimer) clearTimeout(usageSaveTimer);
  usageSaveTimer = setTimeout(() => {
    usageSaveTimer = null;
    guardarVoiceflowUsage();
  }, 150);
}

// Guardado síncrono al cerrar
function guardarSync() {
  try {
    ensureDataDir();
    const payload = JSON.stringify(
      { seq: pedidoSeq, pedidos },
      null,
      2
    );
    fs.writeFileSync(TMP_FILE, payload, 'utf8');
    fs.renameSync(TMP_FILE, DATA_FILE);
  } catch (err) {
    console.error('Error en guardado síncrono final:', err);
  }
}

function guardarUsageSync() {
  try {
    ensureDataDir();
    const payload = JSON.stringify(voiceflowUsage, null, 2);
    fs.writeFileSync(USAGE_TMP_FILE, payload, 'utf8');
    fs.renameSync(USAGE_TMP_FILE, USAGE_FILE);
  } catch (err) {
    console.error('Error en guardado síncrono de auditoría:', err);
  }
}

process.on('SIGINT', () => {
  guardarSync();
  guardarUsageSync();
  process.exit(0);
});
process.on('SIGTERM', () => {
  guardarSync();
  guardarUsageSync();
  process.exit(0);
});

cargarPedidos();
cargarVoiceflowUsage();

/* =============================================================
 * LIMPIEZA PERIÓDICA
 * Borra pedidos en estado "listo" más antiguos que RETENCION_LISTOS_MS
 * para que el archivo no crezca de forma indefinida.
 * ============================================================= */
function limpiarPedidosViejos() {
  const limite = Date.now() - RETENCION_LISTOS_MS;
  const antes = pedidos.length;
  pedidos = pedidos.filter((p) => {
    if (p.estado !== 'listo') return true;
    const ts = p.updatedAt || p.createdAt || 0;
    return ts >= limite;
  });
  if (pedidos.length !== antes) {
    console.log(
      `Limpieza: ${antes - pedidos.length} pedidos "listo" antiguos eliminados.`
    );
    programarGuardado();
  }
}
setInterval(limpiarPedidosViejos, LIMPIEZA_INTERVALO_MS).unref();

/* =============================================================
 * EXPRESS / CORS
 * ============================================================= */

const app = express();
app.set('trust proxy', 1); // Railway está detrás de un proxy
app.use(express.json({ limit: '64kb' }));

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      if (allowedOrigins.includes('*')) {
        callback(null, true);
        return;
      }
      console.warn('CORS rechazado:', origin);
      callback(new Error(`Origen no permitido por CORS: ${origin}`));
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  })
);

// Rate limiting muy ligero por IP para mutaciones (POST/PATCH/DELETE).
// En un piloto de restaurante real (carga baja) este límite no se debería
// alcanzar nunca; protege de un script abusivo apuntando al endpoint público.
const rateBuckets = new Map();
function rateLimitMutaciones(req, res, next) {
  if (req.method === 'GET' || req.method === 'OPTIONS') return next();
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const ahora = Date.now();
  const ventanaInicio = ahora - RATE_LIMIT_WINDOW_MS;

  const lista = rateBuckets.get(ip) || [];
  const recientes = lista.filter((ts) => ts >= ventanaInicio);
  if (recientes.length >= RATE_LIMIT_MAX) {
    res.status(429).json({
      error: 'Demasiadas peticiones, espera unos segundos.',
    });
    return;
  }
  recientes.push(ahora);
  rateBuckets.set(ip, recientes);

  // Limpieza esporádica del mapa
  if (rateBuckets.size > 500) {
    for (const [k, v] of rateBuckets) {
      const limpios = v.filter((ts) => ts >= ventanaInicio);
      if (limpios.length === 0) rateBuckets.delete(k);
      else rateBuckets.set(k, limpios);
    }
  }
  next();
}
app.use(rateLimitMutaciones);

/* =============================================================
 * HELPERS DE PEDIDOS
 * ============================================================= */

function sanitizePedidoItem(item) {
  if (!item || typeof item.nombre !== 'string') return null;
  const nombre = item.nombre.trim().slice(0, 200);
  if (!nombre) return null;
  const cantidad = Math.min(Math.max(Number(item.cantidad) || 1, 1), 99);
  const nota =
    typeof item.nota === 'string' ? item.nota.trim().slice(0, 300) : '';
  return { cantidad, nombre, nota };
}

function formatearHora(ts) {
  return new Date(ts).toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function normalizarMesa(valor) {
  if (valor === undefined || valor === null) return '';
  return String(valor).trim().slice(0, 20);
}

function filtrarPedidos({ estado, estados, mesa, since }) {
  let lista = pedidos;
  if (mesa) {
    const m = normalizarMesa(mesa);
    lista = lista.filter((p) => p.mesa === m);
  }
  if (estados && estados.length > 0) {
    lista = lista.filter((p) => estados.includes(p.estado));
  } else if (estado) {
    lista = lista.filter((p) => p.estado === estado);
  }
  if (since) {
    lista = lista.filter((p) => p.createdAt >= since);
  }
  return lista;
}

function extraerTextoUsuario(body) {
  const payload = body?.action?.payload;
  return typeof payload === 'string' ? payload : '';
}

function contarTextosVoiceflow(body) {
  if (!Array.isArray(body)) return { count: 0, chars: 0, types: [] };
  const types = [];
  let count = 0;
  let chars = 0;
  body.forEach((trace) => {
    if (trace?.type) types.push(trace.type);
    if (trace?.type !== 'text' && trace?.type !== 'speak') return;
    const msg = trace?.payload?.message;
    if (typeof msg !== 'string') return;
    count += 1;
    chars += msg.length;
  });
  return { count, chars, types: [...new Set(types)] };
}

function estimarTokens(chars) {
  return Math.ceil((Number(chars) || 0) / 4);
}

function extraerHeadersUso(headers) {
  const usage = {};
  headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (
      k.includes('token') ||
      k.includes('usage') ||
      k.includes('credit') ||
      k.includes('quota') ||
      k.includes('limit')
    ) {
      usage[key] = value;
    }
  });
  return usage;
}

function registrarUsoVoiceflow({
  sessionId,
  status,
  latencyMs,
  requestBody,
  responseBody,
  responseHeaders,
  error,
}) {
  const userText = extraerTextoUsuario(requestBody);
  const responseInfo = contarTextosVoiceflow(responseBody);
  const inputChars = userText.length;
  const outputChars = responseInfo.chars;
  const record = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    iso: new Date().toISOString(),
    sessionId,
    actionType: requestBody?.action?.type || null,
    status,
    ok: status >= 200 && status < 300 && !error,
    latencyMs,
    inputChars,
    outputChars,
    estimatedInputTokens: estimarTokens(inputChars),
    estimatedOutputTokens: estimarTokens(outputChars),
    estimatedTotalTokens: estimarTokens(inputChars + outputChars),
    responseMessages: responseInfo.count,
    traceTypes: responseInfo.types,
    upstreamUsageHeaders: responseHeaders || {},
    error: error ? String(error.message || error) : null,
  };

  if (AUDIT_STORE_TEXT) {
    record.userText = userText;
    record.responsePreview = Array.isArray(responseBody)
      ? responseBody
          .filter((trace) => trace?.type === 'text' || trace?.type === 'speak')
          .map((trace) => trace?.payload?.message)
          .filter(Boolean)
          .join('\n')
          .slice(0, 1000)
      : '';
  }

  voiceflowUsage.unshift(record);
  if (voiceflowUsage.length > 5000) voiceflowUsage.length = 5000;
  programarGuardadoUsage();
  console.info(
    `Voiceflow ${status} ${latencyMs}ms session=${sessionId} est_tokens=${record.estimatedTotalTokens}`
  );
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_TOKEN) {
    res.status(401).json({ error: 'admin token requerido' });
    return;
  }
  next();
}

function resumenUsoVoiceflow(records) {
  const total = records.length;
  const ok = records.filter((r) => r.ok).length;
  const estimatedTotalTokens = records.reduce(
    (acc, r) => acc + (Number(r.estimatedTotalTokens) || 0),
    0
  );
  const avgLatencyMs = total
    ? Math.round(records.reduce((acc, r) => acc + (Number(r.latencyMs) || 0), 0) / total)
    : 0;
  const byAction = records.reduce((acc, r) => {
    const key = r.actionType || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const byStatus = records.reduce((acc, r) => {
    const key = String(r.status || 'error');
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return {
    totalRequests: total,
    okRequests: ok,
    failedRequests: total - ok,
    estimatedTotalTokens,
    estimatedInputTokens: records.reduce(
      (acc, r) => acc + (Number(r.estimatedInputTokens) || 0),
      0
    ),
    estimatedOutputTokens: records.reduce(
      (acc, r) => acc + (Number(r.estimatedOutputTokens) || 0),
      0
    ),
    avgLatencyMs,
    byAction,
    byStatus,
    exactUsageHeadersAvailable: records.some(
      (r) => r.upstreamUsageHeaders && Object.keys(r.upstreamUsageHeaders).length > 0
    ),
  };
}

/* =============================================================
 * RUTAS
 * ============================================================= */

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'voiceflow-proxy',
    version: '2.0.0',
    pedidos: {
      total: pedidos.length,
      pendiente: pedidos.filter((p) => p.estado === 'pendiente').length,
      en_preparacion: pedidos.filter((p) => p.estado === 'en_preparacion').length,
      listo: pedidos.filter((p) => p.estado === 'listo').length,
    },
    endpoints: [
      'POST /api/state/user/:sessionId/interact',
      'GET /api/voiceflow-usage',
      'GET /api/voiceflow-usage/summary',
      'GET /api/pedidos?estado=pendiente|en_preparacion|listo|activos&mesa=X',
      'GET /api/pedidos/mesa/:mesa',
      'POST /api/pedidos',
      'PATCH /api/pedidos/:id  { "estado": "en_preparacion" | "listo" }',
      'DELETE /api/pedidos/:id',
    ],
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, pedidos: pedidos.length, voiceflowUsage: voiceflowUsage.length });
});

/* ---------- VOICEFLOW PROXY ---------- */

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

app.post('/api/state/user/:sessionId/interact', async (req, res) => {
  const { sessionId } = req.params;
  const startedAt = Date.now();

  if (!SESSION_ID_PATTERN.test(sessionId)) {
    res.status(400).json({ error: 'sessionId inválido' });
    return;
  }

  const targetUrl = `${VOICEFLOW_API_URL}/state/user/${encodeURIComponent(sessionId)}/interact`;

  try {
    const upstream = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        Authorization: VOICEFLOW_API_KEY,
        'Content-Type': 'application/json',
        versionID: VOICEFLOW_VERSION_ID,
      },
      body: JSON.stringify(req.body),
    });

    const contentType = upstream.headers.get('content-type') || '';
    const usageHeaders = extraerHeadersUso(upstream.headers);
    const body = contentType.includes('application/json')
      ? await upstream.json()
      : await upstream.text();

    registrarUsoVoiceflow({
      sessionId,
      status: upstream.status,
      latencyMs: Date.now() - startedAt,
      requestBody: req.body,
      responseBody: body,
      responseHeaders: usageHeaders,
    });

    res.status(upstream.status);
    if (typeof body === 'string') {
      res.type('text').send(body);
    } else {
      res.json(body);
    }
  } catch (err) {
    console.error('Error al contactar Voiceflow:', err);
    registrarUsoVoiceflow({
      sessionId,
      status: 502,
      latencyMs: Date.now() - startedAt,
      requestBody: req.body,
      responseBody: null,
      responseHeaders: {},
      error: err,
    });
    res.status(502).json({ error: 'No se pudo conectar con Voiceflow' });
  }
});

/* ---------- AUDITORÍA VOICEFLOW ---------- */

app.get('/api/voiceflow-usage', requireAdmin, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
  const sessionId = req.query.sessionId ? String(req.query.sessionId) : null;
  const since = Number(req.query.since) || 0;
  const records = voiceflowUsage
    .filter((r) => (!sessionId || r.sessionId === sessionId) && (!since || r.ts >= since))
    .slice(0, limit);
  res.json({
    summary: resumenUsoVoiceflow(records),
    records,
    note:
      'Los tokens son estimados salvo que upstreamUsageHeaders incluya datos reales devueltos por Voiceflow.',
  });
});

app.get('/api/voiceflow-usage/summary', requireAdmin, (req, res) => {
  const since = Number(req.query.since) || 0;
  const records = voiceflowUsage.filter((r) => !since || r.ts >= since);
  res.json({
    ...resumenUsoVoiceflow(records),
    recordsStored: voiceflowUsage.length,
    note:
      'Voiceflow Runtime no siempre devuelve tokens/coste exactos; si no hay headers de uso, son estimaciones por caracteres.',
  });
});

app.delete('/api/voiceflow-usage', requireAdmin, (_req, res) => {
  const deleted = voiceflowUsage.length;
  voiceflowUsage = [];
  programarGuardadoUsage();
  res.json({ ok: true, deleted });
});

/* ---------- PEDIDOS ---------- */

app.get('/api/pedidos', (req, res) => {
  const mesa = req.query.mesa ? normalizarMesa(req.query.mesa) : null;
  const since = Number(req.query.since) || 0;
  const estadoQuery = req.query.estado;

  let estados = null;
  let estado = null;

  if (!estadoQuery || estadoQuery === 'activos') {
    estados = ESTADOS_ACTIVOS;
  } else if (estadoQuery === 'todos' || estadoQuery === 'all') {
    estados = ESTADOS;
  } else {
    const norm = normalizarEstado(estadoQuery);
    if (!norm) {
      res.status(400).json({
        error: 'estado inválido',
        permitidos: [...ESTADOS, 'activos', 'todos'],
      });
      return;
    }
    estado = norm;
  }

  const lista = filtrarPedidos({ estado, estados, mesa, since });
  res.json(lista);
});

app.get('/api/pedidos/mesa/:mesa', (req, res) => {
  const mesa = normalizarMesa(req.params.mesa);
  if (!mesa) {
    res.status(400).json({ error: 'mesa inválida' });
    return;
  }
  // El cliente sólo necesita ver los activos + los listos recientes (2h).
  // Si se pide ?todos=1 devolvemos el histórico completo (útil para debug).
  const verTodos = req.query.todos === '1' || req.query.todos === 'true';
  const limite = Date.now() - 2 * 60 * 60 * 1000;
  const lista = pedidos.filter((p) => {
    if (p.mesa !== mesa) return false;
    if (verTodos) return true;
    if (p.estado !== 'listo') return true;
    return (p.updatedAt || p.createdAt || 0) >= limite;
  });
  res.json(lista);
});

app.post('/api/pedidos', (req, res) => {
  const mesaRaw = req.body?.mesa;
  const itemsRaw = req.body?.items;

  if (mesaRaw === undefined || mesaRaw === null || mesaRaw === '') {
    res.status(400).json({ error: 'mesa es obligatoria' });
    return;
  }
  if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) {
    res.status(400).json({ error: 'items debe ser un array no vacío' });
    return;
  }

  const items = itemsRaw.map(sanitizePedidoItem).filter(Boolean);
  if (items.length === 0) {
    res.status(400).json({ error: 'ningún item válido en el pedido' });
    return;
  }

  pedidoSeq += 1;
  const ahora = Date.now();
  const pedido = {
    id: String(pedidoSeq),
    mesa: normalizarMesa(mesaRaw),
    items,
    estado: 'pendiente',
    createdAt: ahora,
    updatedAt: ahora,
    hora: formatearHora(ahora),
    historial: [{ estado: 'pendiente', ts: ahora }],
  };

  pedidos.unshift(pedido);
  if (pedidos.length > 1000) pedidos.length = 1000;

  programarGuardado();
  res.status(201).json(pedido);
});

app.patch('/api/pedidos/:id', (req, res) => {
  const pedido = pedidos.find((p) => p.id === req.params.id);
  if (!pedido) {
    res.status(404).json({ error: 'pedido no encontrado' });
    return;
  }

  // Estado nuevo: por defecto "listo" para retrocompat con cocina antigua
  const estadoRaw = req.body?.estado || 'listo';
  const estadoNuevo = normalizarEstado(estadoRaw);
  if (!estadoNuevo) {
    res.status(400).json({
      error: 'estado inválido',
      permitidos: ESTADOS,
    });
    return;
  }

  if (pedido.estado !== estadoNuevo) {
    pedido.estado = estadoNuevo;
    pedido.updatedAt = Date.now();
    if (!Array.isArray(pedido.historial)) pedido.historial = [];
    pedido.historial.push({ estado: estadoNuevo, ts: pedido.updatedAt });
    programarGuardado();
  }

  res.json(pedido);
});

app.delete('/api/pedidos/:id', (req, res) => {
  const idx = pedidos.findIndex((p) => p.id === req.params.id);
  if (idx === -1) {
    res.status(404).json({ error: 'pedido no encontrado' });
    return;
  }

  const pedido = pedidos[idx];
  // Si la petición viene del cliente (rol omitido o "cliente"), solo se
  // permite cancelar mientras el pedido sigue en estado "pendiente". Una
  // vez la cocina lo coge "en_preparacion" o lo deja "listo", el cliente
  // ya no puede deshacerlo por sí mismo: tiene que avisar al camarero.
  // El panel de cocina puede saltarse la restricción enviando ?force=1.
  const force = req.query.force === '1' || req.query.force === 'true';
  if (!force && pedido.estado !== 'pendiente') {
    res.status(409).json({
      error: 'no se puede cancelar: el pedido ya está en marcha',
      estado: pedido.estado,
    });
    return;
  }

  const [eliminado] = pedidos.splice(idx, 1);
  programarGuardado();
  res.json({ ok: true, eliminado });
});

/* ---------- ERROR HANDLER ---------- */

app.use((err, _req, res, _next) => {
  if (err.message?.includes('CORS')) {
    res.status(403).json({ error: err.message });
    return;
  }
  if (err.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'JSON del cuerpo inválido' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

app.listen(PORT, () => {
  console.log(`voiceflow-proxy escuchando en puerto ${PORT}`);
  console.log(`Datos persistentes en: ${DATA_FILE}`);
});
