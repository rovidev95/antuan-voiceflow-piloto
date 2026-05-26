# Antuan — Asistente de mesa + Pantalla de cocina

Sistema completo para que el comensal pida desde el móvil (voz o texto) hablando con un asistente Voiceflow, y la cocina vea los pedidos en tiempo real con estados completos.

## Estructura

```
/
├── index.html                ← Web del cliente (mesa)
├── cocina.html               ← Pantalla de cocina
├── netlify.toml              ← Config de Netlify (auto-deploy)
├── .gitignore
└── voiceflow-proxy/          ← Backend en Node.js (Railway)
    ├── server.js             ← Proxy Voiceflow + gestión de pedidos
    ├── railway.json
    ├── nixpacks.toml
    └── README.md             ← Detalle técnico del backend
```

## ¿Qué hace?

- **Mesa (`index.html`)**: chat con Antuan (Voiceflow), carta, micrófono, carrito y **panel de estado del pedido** que se actualiza solo (`pendiente → en preparación → listo`).
- **Cocina (`cocina.html`)**: panel oscuro con todos los pedidos agrupados **por mesa**, filtros por estado, botones de **Empezar / Listo / Cancelar** y notificación sonora al llegar uno nuevo.
- **Backend (`voiceflow-proxy/`)**: proxy CORS a Voiceflow + API de pedidos **persistentes en disco** (sobreviven a reinicios del servidor).

## Despliegue automático

| Pieza | Plataforma | Detalle |
|-------|------------|---------|
| `index.html`, `cocina.html` | **Netlify** | Cada push a `main` publica |
| `voiceflow-proxy/` | **Railway** | Cada push a `main` redeploya; pedidos en Volume |

Pasos completos en [`voiceflow-proxy/DEPLOY-RAILWAY.md`](./voiceflow-proxy/DEPLOY-RAILWAY.md).

## URLs en producción

| Pieza | URL |
|-------|-----|
| Mesa | https://bright-sorbet-e94b45.netlify.app/ |
| Cocina | https://bright-sorbet-e94b45.netlify.app/cocina.html |
| Backend | https://affectionate-clarity-production-f27b.up.railway.app |

Mesa concreta: añade `?mesa=12` a la URL del cliente.

## Estados de los pedidos

| Estado | Significado | Visible en mesa | Acción en cocina |
|--------|-------------|------------------|-------------------|
| `pendiente` | Acaba de llegar | "Recibido en cocina" | Botón **▶ Empezar** |
| `en_preparacion` | Cocina lo está preparando | "Preparando 🍳" | Botón **✓ Listo** |
| `listo` | Listo para servir | "¡Listo! ✅" | (auto-oculta a los 30 s) |

El cliente recibe avisos automáticos en el chat cuando su pedido cambia de estado.

## Persistencia

El backend guarda los pedidos en `voiceflow-proxy/data/pedidos.json` con escritura atómica. En Railway hay que **montar un Volume** sobre `/app/data` para que los pedidos sobrevivan a redeploys o reinicios. Si no se monta, el servidor sigue funcionando pero los datos se borran al reiniciar.

## Desarrollo local

```bash
cd voiceflow-proxy
cp .env.example .env  # rellena VOICEFLOW_API_KEY
npm install
npm run dev
```

Backend en `http://localhost:3000`. Abre `index.html` y `cocina.html` con un servidor estático (Live Server, `npx serve .`, etc.) y ajusta `PROXY_URL` a `http://localhost:3000` para pruebas.
