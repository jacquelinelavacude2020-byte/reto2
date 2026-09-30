# Reto 02 · Agente de Registro de Contratos Vigentes

Agente conversacional en TypeScript (Node 20+ o Bun) que actúa como **punto único de recepción** del buzón de contratos: lee los correos, extrae el contrato con confianza por campo, lo valida contra el maestro (RN1–RN7), pide confirmación humana cuando algo es dudoso, registra y archiva en un SharePoint simulado y genera el reporte de alertas.

- Planteamiento, arquitectura, costos y **regla de gobierno**: [`SOLUCION.md`](SOLUCION.md)
- Link de prueba: **`<pegar aquí la URL de Render/Railway>`** · clave de acceso: **`<ACCESS_KEY configurada>`** (ver «Despliegue»)

## Arranque local (un comando)

```bash
cp .env.example .env          # y poner la clave del proveedor (ver «Proveedores»)
npm install && npm run dev    # → http://localhost:3000
```

Con Bun: `bun install && bun run dev:bun`. Con Docker: `docker compose up --build`.

Sin clave el servidor igual arranca: el front carga, el panel del maestro funciona y el chat muestra un error claro («Falta la clave del proveedor…»).

## Proveedores

| Proveedor | En `.env` | Modelo por defecto | Nota |
|---|---|---|---|
| Google Gemini (**gratis**) | `LLM_PROVIDER=gemini` + `GEMINI_API_KEY=...` | `gemini-3.6-flash` | Clave gratuita en https://aistudio.google.com/apikey. La capa gratuita limita peticiones por minuto: el adaptador reintenta solo ante HTTP 429. Google puede usar los datos de la capa gratuita para mejorar sus productos (los fixtures son ficticios). |
| Anthropic | `LLM_PROVIDER=anthropic` + `ANTHROPIC_API_KEY=...` | `claude-sonnet-5-5` | De pago. |
| OpenAI o compatible | `LLM_PROVIDER=openai` + `OPENAI_API_KEY=...` | `gpt-5-mini` | `OPENAI_BASE_URL` para Azure u otros compatibles. |

Ejemplo mínimo con Gemini gratis (Windows PowerShell):

```powershell
Copy-Item .env.example .env
notepad .env        # LLM_PROVIDER=gemini  y  GEMINI_API_KEY=<tu clave>
npm install
npm run dev         # → http://localhost:3000
```

## Verificación sin modelo (`demo.ts`)

```bash
npm install && npm run demo      # o: bun install && bun run demo.ts
```

Limpia `out/`, procesa `msg-001`…`msg-006` en orden llamando directamente a las herramientas, deja `msg-006` **sin registrar** en la primera pasada, lo registra en una segunda llamada con `confirmado: true`, genera `out/alertas.md` con `hoy = 2026-09-03`, ejercita errores tipados (HU-6) y termina comparando contra la tabla 7.4 del PRD (exit code ≠ 0 si algo no coincide). No necesita ninguna clave.

Otras verificaciones:

| Comando | Qué hace |
|---|---|
| `npm run typecheck` | `tsc --noEmit` (strict, sin `any`) |
| `npm run smoke` | Ciclo del agente con un modelo guionizado: tope de iteraciones, bloqueo de `confirmado=true` sin pregunta previa, `needsConfirmation` |
| `npm run modulo:check` | Verifica que `modulo/` sea idéntico a sus fuentes (bonus 9.4) |
| `npm run check` | Las tres anteriores + demo |

## Variables de entorno

| Variable | Obligatoria | Default | Uso |
|---|---|---|---|
| `LLM_PROVIDER` | no | `anthropic` | `anthropic`, `openai` o `gemini` |
| `LLM_MODEL` | no | `claude-sonnet-5-5` / `gpt-5-mini` / `gemini-3.6-flash` | Modelo del proveedor |
| `ANTHROPIC_API_KEY` | sí, si provider = anthropic | — | Solo backend |
| `OPENAI_API_KEY` | sí, si provider = openai | — | Solo backend |
| `GEMINI_API_KEY` | sí, si provider = gemini | — | Solo backend (también acepta `GOOGLE_API_KEY`) |
| `GEMINI_THINKING_LEVEL` | no | `low` | Nivel de pensamiento de Gemini 3; vacío = no se envía |
| `GEMINI_MAX_REINTENTOS` | no | `3` | Reintentos ante 429/503 respetando el `retryDelay` de Google |
| `OPENAI_BASE_URL` | no | `https://api.openai.com/v1` | Endpoints compatibles (Azure, local) |
| `LLM_TIMEOUT_MS` | no | `60000` | Timeout por llamada al proveedor |
| `LLM_MAX_TOKENS` | no | `2048` (`8192` con gemini) | Tope de salida por llamada |
| `MAX_ITERACIONES` | no | `25` | Tope herramienta→modelo por turno (CA1) |
| `SESSION_MAX_TOKENS` | no | `400000` | Tope de tokens por sesión (costo) |
| `ACCESS_KEY` | no | — | Si se define, el front la pide y la API exige el header `x-access-key` |
| `PORT` | no | `3000` | Puerto HTTP |

## Uso en el chat

Prompt de la demo (sección 11 del PRD):

```
Procesa el buzón de contratos con fecha de hoy 2026-09-03. Registra lo que
esté limpio, muéstrame lo que requiere revisión campo por campo y termina
con el reporte de alertas. No registres nada dudoso sin preguntarme.
```

Luego: `confirmo el valor 0 y la fecha fin 2027-08-31` (o el botón **Confirmar lo propuesto**). Cada llamada a herramienta aparece en el chat (desplegable con argumentos y resultado); cuando el agente pide confirmación, el mensaje se marca con el sello rojo **«Requiere tu confirmación»**. El panel lateral muestra el maestro de trabajo y `alertas.md`; **Reiniciar datos** borra `out/` para repetir la demo.

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation, pendientesConfirmacion[], iteraciones, usage, tokensSesion }` |
| `POST` | `/api/chat?stream=1` | Igual, como Server-Sent Events: `usuario`, `pensando`, `herramienta`, `asistente`, `error` y `fin` |
| `GET` | `/api/sessions/:id` | Historial visible completo de la sesión |
| `GET` | `/api/health` | `{ ok, provider, model, llmConfigurado, herramientas[] }` — nunca claves |
| `GET` | `/api/maestro` | Filas del maestro de trabajo |
| `GET` | `/api/alertas` | Contenido de `out/alertas.md` |
| `POST` | `/api/reset` | Borra `out/` |

`sessionId`: 6–64 caracteres `[a-zA-Z0-9_-]`. Límite de 20 mensajes por minuto por IP.

## Despliegue

**Render (recomendado, blueprint incluido):** subir el repo a GitHub → Render → *New → Blueprint* → elegir el repo (usa `render.yaml`) → cargar la clave del proveedor (`GEMINI_API_KEY` o `ANTHROPIC_API_KEY`) y `ACCESS_KEY` en el panel → *Apply*. Health check: `/api/health`.

**Railway / Fly / cualquier Docker:** `Dockerfile` incluido; variables igual que arriba. `out/` es efímero en esos planes: al reiniciar el contenedor el maestro vuelve al fixture, lo que para la defensa es deseable.

## Estructura

```
agent/prompt.md                 comportamiento (system prompt)
src/knowledge/*.md              conocimiento del proceso (se anexa al prompt)
src/tools/contratos.ts          herramientas zod (contratos_<export>) — importables sin servidor
src/tools/{extraccion,evaluacion,operaciones,almacen,texto,reglas,tipos}.ts
src/llm/{adapter,anthropic,openai,gemini,esquema,index}.ts   adaptador de proveedor
src/agente/{ciclo,herramientas,sesiones}.ts           ciclo del agente
src/server.ts                   API HTTP + SSE + estáticos (node:http, sin framework)
web/                            front de chat (HTML + CSS + JS, sin build)
demo.ts                         verificación sin modelo
modulo/                         bonus 9.4 (generado por scripts/modulo.ts)
fixtures/                       insumos del reto (solo lectura)
out/                            generado en ejecución (no se entrega)
```
