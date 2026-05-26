# Voiceflow Proxy + Cocina (Antuan)

Servidor Node.js (Express) que cumple dos funciones:

1. **Proxy CORS a Voiceflow**: la API key vive sólo en el servidor; el frontend en Netlify nunca la ve.
2. **Backend de pedidos** entre la web de mesa (`index.html`) y la pantalla de cocina (`cocina.html`): registra los pedidos por mesa con estados completos y los **persiste a disco** para que sobrevivan a reinicios.

## Requisitos

- Node.js 18+ (recomendado 20 LTS)
- Cuenta en [Railway](https://railway.app)
- Cuenta en [Netlify](https://app.netlify.com) (frontend)
- API key de Voiceflow (`VF.DM....`)

## Variables de entorno

| Variable | Obligatoria | Descripción |
|----------|-------------|-------------|
| `VOICEFLOW_API_KEY` | Sí | API key de Voiceflow |
| `ALLOWED_ORIGINS` | Recomendada | Dominio(s) de Netlify, separados por coma |
| `VOICEFLOW_API_URL` | No | Por defecto `https://general-runtime.voiceflow.com` |
| `VOICEFLOW_VERSION_ID` | No | Alias de Voiceflow (`main`, no `production` en proyectos nuevos) |
| `DATA_DIR` | No | Carpeta donde persistir `pedidos.json`. Por defecto `./data` |
| `PORT` | No | Railway lo asigna automáticamente |

Ejemplo `.env`:

```env
VOICEFLOW_API_KEY=VF.DM.xxxxx
VOICEFLOW_VERSION_ID=main
ALLOWED_ORIGINS=https://bright-sorbet-e94b45.netlify.app
DATA_DIR=/app/data
```

## Persistencia de pedidos

Los pedidos viven en `${DATA_DIR}/pedidos.json` con escritura atómica (`writeFile` + `rename`) y debounce. Esto es lo que garantiza que **si Railway reinicia el contenedor, no se pierde nada**.

> ⚠️ En Railway hay que montar un **Volume** sobre la carpeta de datos (p. ej. `/app/data`) y poner `DATA_DIR=/app/data`. Sin volumen, el archivo se borra en cada deploy.

Pasos en Railway:

1. Servicio → **Settings → Volumes → Add Volume**.
2. Mount path: `/app/data`.
3. En **Variables**, añade `DATA_DIR=/app/data`.
4. Redeploy.

## Estados de un pedido

| Estado | Significado |
|--------|-------------|
| `pendiente` | Recién llegado a cocina |
| `en_preparacion` | El cocinero le ha dado a "Empezar" |
| `listo` | El cocinero le ha dado a "Listo" |

El historial completo de transiciones se guarda en `pedido.historial`.

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/` | Info del servicio + conteos |
| `GET` | `/health` | Health check (Railway lo usa) |
| `POST` | `/api/state/user/:sessionId/interact` | Proxy al runtime de Voiceflow |
| `GET` | `/api/pedidos?estado=...&mesa=...` | Lista pedidos. `estado` admite `pendiente`, `en_preparacion`, `listo`, `activos`, `todos` |
| `GET` | `/api/pedidos/mesa/:mesa` | Todos los pedidos (histórico) de una mesa |
| `POST` | `/api/pedidos` | Registra un pedido nuevo |
| `PATCH` | `/api/pedidos/:id` | Cambia el estado: `{ "estado": "en_preparacion" \| "listo" }` |
| `DELETE` | `/api/pedidos/:id` | Cancela/elimina un pedido |

Cuerpo de `POST /api/pedidos`:

```json
{
  "mesa": "7",
  "items": [
    { "cantidad": 2, "nombre": "Croquetas", "nota": "Sin lactosa" }
  ]
}
```

Cuerpo de `PATCH /api/pedidos/:id`:

```json
{ "estado": "en_preparacion" }
```

## URLs de producción

| Página | URL | Archivo |
|--------|-----|---------|
| Mesa (comensal) | https://bright-sorbet-e94b45.netlify.app/ | `index.html` |
| Cocina | https://bright-sorbet-e94b45.netlify.app/cocina.html | `cocina.html` |
| Proxy (Railway) | https://affectionate-clarity-production-f27b.up.railway.app | `voiceflow-proxy/` |

Mesa configurable por query string: `?mesa=12`.

## Despliegue automático (Git → Railway + Netlify)

Esta carpeta + los HTML del repo están preparados para que cada `git push` despliegue solo, sin tocar paneles.

1. **Repositorio en GitHub**: sube todo el repo (mesa + cocina + proxy). El `.gitignore` excluye `node_modules`, `.env` y datos.
2. **Railway**:
   - "New Project → Deploy from GitHub repo".
   - Selecciona la carpeta `voiceflow-proxy` como root (o crea un servicio con `WORKDIR=/voiceflow-proxy`).
   - Variables: `VOICEFLOW_API_KEY`, `ALLOWED_ORIGINS`, `VOICEFLOW_VERSION_ID=main`, `DATA_DIR=/app/data`.
   - Settings → Volumes → mount `/app/data`.
   - Settings → Networking → Generate Domain. Copia esa URL en `PROXY_URL` de `index.html` y `cocina.html`.
   - Cada push a `main` redeploya automáticamente.
3. **Netlify**:
   - "Add new site → Import from Git".
   - Build command: vacío. Publish directory: `.` (ya configurado en `netlify.toml`).
   - Cada push a `main` publica los HTML.

Más detalle paso a paso en [`DEPLOY-RAILWAY.md`](./DEPLOY-RAILWAY.md).

## Desarrollo local

```bash
cd voiceflow-proxy
cp .env.example .env
# Edita .env con tu API key
npm install
npm run dev
```

Proxy en `http://localhost:3000`.

Pruebas rápidas:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/api/pedidos
curl -X POST http://localhost:3000/api/pedidos \
  -H "Content-Type: application/json" \
  -d '{"mesa":"7","items":[{"cantidad":1,"nombre":"Croquetas"}]}'
curl -X PATCH http://localhost:3000/api/pedidos/1 \
  -H "Content-Type: application/json" \
  -d '{"estado":"en_preparacion"}'
```

## Seguridad

- La API key sólo vive en Railway.
- Rotar la key de Voiceflow si estuvo expuesta en el HTML antiguo.
- Mantén `ALLOWED_ORIGINS` acotado al dominio de producción.
