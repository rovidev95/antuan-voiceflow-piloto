# Guía rápida de despliegue (para el cliente)

Despliegue **automático** con Git: cada push a `main` publica frontend (Netlify) y backend (Railway).

## URLs del proyecto

| Qué | URL |
|-----|-----|
| Mesa (`index.html`) | https://bright-sorbet-e94b45.netlify.app/ |
| Cocina (`cocina.html`) | https://bright-sorbet-e94b45.netlify.app/cocina.html |
| Proxy (Railway) | https://affectionate-clarity-production-f27b.up.railway.app |

Mesa y cocina comparten el **mismo sitio** Netlify. En CORS basta el dominio (sin `/cocina.html`).

## 1. Subir el repo a GitHub

Estructura esperada (ya está así):

```
/                  ← Netlify publica desde aquí (index.html, cocina.html)
├── netlify.toml
├── index.html
├── cocina.html
└── voiceflow-proxy/   ← Railway construye desde aquí
    ├── server.js
    ├── package.json
    ├── railway.json
    ├── nixpacks.toml
    └── ...
```

Crea el repo en GitHub y haz `git push`. El `.gitignore` ya excluye `node_modules`, `.env` y los pedidos persistentes.

## 2. Railway (backend)

1. [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**.
2. Selecciona el repo. Railway detecta Node.js (`nixpacks.toml`).
3. **Settings → Root Directory** → `voiceflow-proxy`.
4. **Variables** del servicio:

| Variable | Valor |
|----------|-------|
| `VOICEFLOW_API_KEY` | La API key de Voiceflow |
| `VOICEFLOW_VERSION_ID` | `main` |
| `ALLOWED_ORIGINS` | `https://bright-sorbet-e94b45.netlify.app` |
| `DATA_DIR` | `/app/data` |

5. **Settings → Volumes → Add Volume**:
   - Mount path: `/app/data`
   - Size: 1 GB (más que de sobra)
6. **Settings → Networking → Generate Domain** → copia la URL pública.
7. Si la URL no coincide con la actual, actualízala en `PROXY_URL` (línea de configuración) tanto de `index.html` como de `cocina.html`.

Cada push a `main` redeploya automáticamente. Los pedidos no se pierden porque viven en el Volume.

## 3. Netlify (frontend)

1. [app.netlify.com](https://app.netlify.com) → **Add new site → Import from Git**.
2. Repo del paso 1.
3. Branch: `main`. Build command: vacío. Publish directory: `.` (`netlify.toml` lo fija).
4. **Deploy site**. La URL queda fija en `bright-sorbet-e94b45.netlify.app` (o renómbrala desde Settings).

Cada push a `main` publica `index.html` y `cocina.html`. No hace falta tocar nada.

## 4. Comprobar el despliegue

**Proxy:**

```text
https://affectionate-clarity-production-f27b.up.railway.app/health
→ {"ok":true, "pedidos": N}
```

**Cocina:** abre `https://bright-sorbet-e94b45.netlify.app/cocina.html` → debe poner **"Conectado"**.

**Mesa:** escribe un pedido en `https://bright-sorbet-e94b45.netlify.app/` → en cocina aparece la tarjeta de la mesa.

**Estados:**
- Cocina pulsa **▶ Empezar** → la mesa ve "Preparando 🍳" en el panel "Estado de tu pedido".
- Cocina pulsa **✓ Listo** → la mesa ve "¡Listo! ✅" y un aviso en el chat.

**Persistencia:** redeploya Railway. Los pedidos siguen ahí.

## 5. Rotar API key (recomendado)

La key estuvo en el HTML viejo. En Voiceflow genera una nueva y actualiza sólo `VOICEFLOW_API_KEY` en Railway.

## Pequeños extras

- Mesa por URL: `?mesa=12`.
- Ver pedidos de una mesa: `GET /api/pedidos/mesa/12`.
- Filtros en cocina: pendiente, en preparación, listos, activos.
