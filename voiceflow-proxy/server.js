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
let saveTimer = null;
let saving = false;
let pendingSave = false;

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

function programarGuardado() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    guardarPedidos();
  }, 150); // pequeño debounce para agrupar escrituras
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

process.on('SIGINT', () => {
  guardarSync();
  process.exit(0);
});
process.on('SIGTERM', () => {
  guardarSync();
  process.exit(0);
});

cargarPedidos();

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
      'GET /api/pedidos?estado=pendiente|en_preparacion|listo|activos&mesa=X',
      'GET /api/pedidos/mesa/:mesa',
      'POST /api/pedidos',
      'PATCH /api/pedidos/:id  { "estado": "en_preparacion" | "listo" }',
      'DELETE /api/pedidos/:id',
    ],
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, pedidos: pedidos.length });
});

/* ---------- VOICEFLOW PROXY ---------- */

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

app.post('/api/state/user/:sessionId/interact', async (req, res) => {
  const { sessionId } = req.params;

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
    const body = contentType.includes('application/json')
      ? await upstream.json()
      : await upstream.text();

    res.status(upstream.status);
    if (typeof body === 'string') {
      res.type('text').send(body);
    } else {
      res.json(body);
    }
  } catch (err) {
    console.error('Error al contactar Voiceflow:', err);
    res.status(502).json({ error: 'No se pudo conectar con Voiceflow' });
  }
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
