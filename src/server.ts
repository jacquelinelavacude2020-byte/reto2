/**
 * Servidor HTTP (node:http, compatible con Node 20+ y Bun). Expone la API del chat y sirve el front.
 *
 *   POST /api/chat            { sessionId, message } → { reply, toolCalls[], needsConfirmation, ... }
 *   POST /api/chat?stream=1   igual, pero como Server-Sent Events (eventos en vivo + "fin")
 *   GET  /api/sessions/:id    historial completo de la sesión
 *   GET  /api/health          { ok, provider, model } (sin claves)
 *   GET  /api/maestro         filas actuales del maestro (out/ o fixture)
 *   GET  /api/alertas         contenido de out/alertas.md si existe
 *   POST /api/reset           limpia out/ para repetir la demo
 */
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { z } from "zod"
import { ejecutarTurno } from "./agente/ciclo"
import { cargarHerramientas } from "./agente/herramientas"
import { AlmacenSesiones } from "./agente/sesiones"
import { CONFIG, RAIZ, claveProveedor } from "./config"
import { ErrorProveedor } from "./llm/adapter"
import { crearAdaptador } from "./llm"
import { leerArchivoSalida, leerMaestro, limpiarSalida } from "./tools/almacen"
import { RUTAS } from "./tools/reglas"

const herramientas = cargarHerramientas()
const sesiones = new AlmacenSesiones(path.join(RAIZ, RUTAS.out, "sesiones"))
const ctxBase = { directory: RAIZ, sessionId: "api" }

const ChatSchema = z.object({
  sessionId: z.string().regex(/^[a-zA-Z0-9_-]{6,64}$/, "sessionId inválido"),
  message: z.string().trim().min(1, "mensaje vacío").max(4000, "mensaje demasiado largo (máx. 4000)"),
})

// ---------------------------------------------------------------- utilidades HTTP

function json(res: http.ServerResponse, estado: number, cuerpo: unknown): void {
  res.writeHead(estado, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  res.end(JSON.stringify(cuerpo))
}

async function leerCuerpo(req: http.IncomingMessage, max = 64_000): Promise<unknown> {
  let total = 0
  const trozos: Buffer[] = []
  for await (const t of req) {
    const b = t as Buffer
    total += b.length
    if (total > max) throw new Error("cuerpo demasiado grande")
    trozos.push(b)
  }
  const texto = Buffer.concat(trozos).toString("utf8")
  return texto ? (JSON.parse(texto) as unknown) : {}
}

function autorizado(req: http.IncomingMessage): boolean {
  if (!CONFIG.claveAcceso) return true
  return req.headers["x-access-key"] === CONFIG.claveAcceso
}

const ventanas = new Map<string, number[]>()
function dentroDeLimite(req: http.IncomingMessage, porMinuto = 20): boolean {
  const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "?").split(",")[0]?.trim() ?? "?"
  const ahora = Date.now()
  const recientes = (ventanas.get(ip) ?? []).filter((t) => ahora - t < 60_000)
  recientes.push(ahora)
  ventanas.set(ip, recientes)
  return recientes.length <= porMinuto
}

const TIPOS: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
}

function servirEstatico(res: http.ServerResponse, url: string): void {
  const web = path.join(RAIZ, "web")
  const relativo = url === "/" ? "index.html" : decodeURIComponent(url.slice(1))
  const archivo = path.resolve(web, relativo)
  if (!archivo.startsWith(web + path.sep) || !fs.existsSync(archivo) || !fs.statSync(archivo).isFile()) {
    json(res, 404, { ok: false, error: "no encontrado" })
    return
  }
  res.writeHead(200, { "content-type": TIPOS[path.extname(archivo)] ?? "application/octet-stream" })
  fs.createReadStream(archivo).pipe(res)
}

// ---------------------------------------------------------------- chat

async function manejarChat(req: http.IncomingMessage, res: http.ServerResponse, stream: boolean): Promise<void> {
  if (!dentroDeLimite(req)) return json(res, 429, { ok: false, error: "Demasiadas peticiones. Espere un minuto." })
  const parsed = ChatSchema.safeParse(await leerCuerpo(req))
  if (!parsed.success) return json(res, 400, { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") })
  const { sessionId, message } = parsed.data

  let adaptador
  try {
    adaptador = crearAdaptador()
  } catch (e) {
    return json(res, 503, { ok: false, error: e instanceof ErrorProveedor ? e.message : "proveedor LLM no disponible" })
  }
  if (!sesiones.tomar(sessionId)) return json(res, 409, { ok: false, error: "Esta sesión ya está procesando un mensaje. Espere a que termine." })

  const sesion = sesiones.obtenerOCrear(sessionId)
  const enviarSse = (evento: string, datos: unknown): void => {
    res.write(`event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`)
  }
  if (stream) {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" })
  }
  const latido = stream ? setInterval(() => res.write(": ping\n\n"), 15_000) : null
  try {
    const resultado = await ejecutarTurno(sesion, message, {
      adaptador,
      herramientas,
      directorio: RAIZ,
      maxIteraciones: CONFIG.maxIteraciones,
      maxTokensSesion: CONFIG.maxTokensSesion,
      onEvento: stream ? (e) => enviarSse(e.tipo, e) : undefined,
    })
    sesiones.guardar(sesion)
    const cuerpo = { ok: true, sessionId, ...resultado, tokensSesion: sesion.tokens }
    if (stream) {
      enviarSse("fin", cuerpo)
      res.end()
    } else json(res, 200, cuerpo)
  } finally {
    if (latido) clearInterval(latido)
    sesiones.soltar(sessionId)
  }
}

// ---------------------------------------------------------------- enrutador

async function enrutar(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost")
  const ruta = url.pathname
  const metodo = req.method ?? "GET"

  if (ruta === "/api/health") {
    return json(res, 200, {
      ok: true,
      provider: CONFIG.proveedor,
      model: CONFIG.modelo,
      llmConfigurado: claveProveedor() !== "",
      requiereClaveAcceso: CONFIG.claveAcceso !== "",
      herramientas: [...herramientas.keys()],
      maxIteraciones: CONFIG.maxIteraciones,
    })
  }
  if (!ruta.startsWith("/api/")) return servirEstatico(res, ruta)
  if (!autorizado(req)) return json(res, 401, { ok: false, error: "Clave de acceso requerida o incorrecta." })

  if (ruta === "/api/chat" && metodo === "POST") return manejarChat(req, res, url.searchParams.get("stream") === "1")

  const sesionMatch = /^\/api\/sessions\/([a-zA-Z0-9_-]{6,64})$/.exec(ruta)
  if (sesionMatch?.[1] && metodo === "GET") {
    const s = sesiones.obtener(sesionMatch[1])
    if (!s) return json(res, 404, { ok: false, error: "sesión no encontrada" })
    return json(res, 200, { ok: true, id: s.id, creada: s.creada, vista: s.vista, tokens: s.tokens, pendientesConfirmacion: s.confirmacionPendiente })
  }
  if (ruta === "/api/maestro" && metodo === "GET") {
    return json(res, 200, { ok: true, filas: leerMaestro(ctxBase) })
  }
  if (ruta === "/api/alertas" && metodo === "GET") {
    return json(res, 200, { ok: true, markdown: leerArchivoSalida(ctxBase, RUTAS.alertas) })
  }
  if (ruta === "/api/reset" && metodo === "POST") {
    limpiarSalida(ctxBase)
    sesiones.limpiar()
    return json(res, 200, { ok: true })
  }
  return json(res, 404, { ok: false, error: "ruta no encontrada" })
}

const servidor = http.createServer((req, res) => {
  enrutar(req, res).catch((e: unknown) => {
    const error = e instanceof Error ? e.message : "error interno"
    if (!res.headersSent) json(res, 500, { ok: false, error })
    else res.end()
  })
})

servidor.listen(CONFIG.puerto, () => {
  const clave = claveProveedor() ? "configurada" : "NO configurada (el chat mostrará el error; demo.ts funciona igual)"
  console.log(`Agente de contratos en http://localhost:${CONFIG.puerto} · ${CONFIG.proveedor}/${CONFIG.modelo} · clave ${clave}`)
})
