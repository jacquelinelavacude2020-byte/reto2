/**
 * Ciclo del agente: prompt → modelo → herramientas → modelo … → respuesta.
 * - CA1: tope de iteraciones por turno y de tokens por sesión.
 * - CA3: confirmación humana aplicada en el servidor (no solo en el prompt): `confirmado=true`
 *   solo se acepta para mensajes cuya solicitud de revisión ya vio el usuario en un turno anterior.
 * - CA4: cada llamada queda en la vista de la sesión (y en out/log.jsonl vía las herramientas).
 * - CA5: errores de herramienta o proveedor se devuelven en lenguaje claro; la sesión sigue viva.
 */
import fs from "node:fs"
import path from "node:path"
import { ErrorProveedor, type AdaptadorLLM, type LlamadaHerramienta, type ResultadoHerramienta } from "../llm/adapter"
import { registrarLog, type Ctx } from "../tools/almacen"
import type { HerramientaRegistrada } from "./herramientas"
import type { EventoVista, Sesion } from "./sesiones"

export interface DependenciasCiclo {
  adaptador: AdaptadorLLM
  herramientas: Map<string, HerramientaRegistrada>
  directorio: string
  maxIteraciones: number
  maxTokensSesion: number
  onEvento?: (e: EventoVista | { tipo: "pensando"; iteracion: number }) => void
}

export type EventoHerramienta = Extract<EventoVista, { tipo: "herramienta" }>

export interface ResultadoTurno {
  reply: string
  toolCalls: EventoHerramienta[]
  needsConfirmation: boolean
  pendientesConfirmacion: string[]
  iteraciones: number
  usage: { entrada: number; salida: number }
}

// ---------------------------------------------------------------- system prompt

/** Comportamiento (agent/prompt.md) + conocimiento (src/knowledge/*.md). Se relee en cada turno. */
export function construirSystemPrompt(directorio: string): string {
  const prompt = fs.readFileSync(path.join(directorio, "agent/prompt.md"), "utf8")
  const dirConocimiento = path.join(directorio, "src/knowledge")
  const conocimiento = fs
    .readdirSync(dirConocimiento)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => fs.readFileSync(path.join(dirConocimiento, f), "utf8"))
    .join("\n\n")
  return `${prompt.trim()}\n\n---\n\n# Conocimiento del proceso\n\n${conocimiento.trim()}\n\n---\nFecha del servidor: ${new Date().toISOString().slice(0, 10)}.`
}

// ---------------------------------------------------------------- utilidades

const ahora = (): string => new Date().toISOString()

function parsearResultado(contenido: string): { ok: boolean; data: Record<string, unknown>; error: string } {
  try {
    const r = JSON.parse(contenido) as { ok?: boolean; data?: unknown; error?: unknown }
    const data = typeof r.data === "object" && r.data !== null ? (r.data as Record<string, unknown>) : {}
    return { ok: r.ok === true, data, error: typeof r.error === "string" ? r.error : "" }
  } catch {
    return { ok: false, data: {}, error: "resultado ilegible" }
  }
}

function resumir(nombre: string, contenido: string): string {
  const r = parsearResultado(contenido)
  if (!r.ok) return r.error.slice(0, 200)
  const d = r.data
  const lista = (v: unknown): string => (Array.isArray(v) ? v.join(", ") : "")
  switch (nombre) {
    case "contratos_leer_buzon":
      return `${Array.isArray(d.mensajes) ? d.mensajes.length : 0} mensajes pendientes`
    case "contratos_extraer":
      return `${String(d.tipo_documento)} ${String(d.id_contrato ?? "sin id")}`
    case "contratos_validar":
      return `${String(d.clasificacion)}${lista(d.requiere_revision) ? ` · revisión: ${lista(d.requiere_revision)}` : ""}`
    case "contratos_registrar":
      return `${String(d.accion)} ${String(d.id_contrato ?? "")}`.trim()
    case "contratos_alertas":
      return `vencen ${Array.isArray(d.vencen) ? d.vencen.length : 0} · pólizas ${Array.isArray(d.polizas_pendientes) ? d.polizas_pendientes.length : 0} · desde corte ${Array.isArray(d.registrados_desde_corte) ? d.registrados_desde_corte.length : 0}`
    default:
      return typeof d.total === "number" ? `${d.total} resultados` : "ok"
  }
}

function mensajeIdDe(args: unknown): string | null {
  return typeof args === "object" && args !== null && "mensaje_id" in args && typeof args.mensaje_id === "string" ? args.mensaje_id : null
}

function pideConfirmacion(args: unknown): boolean {
  return typeof args === "object" && args !== null && "confirmado" in args && args.confirmado === true
}

// ---------------------------------------------------------------- ejecución de una llamada

interface EstadoConfirmacion {
  permitidos: Set<string>
  pendientes: Set<string>
}

async function ejecutarLlamada(
  l: LlamadaHerramienta,
  deps: DependenciasCiclo,
  ctx: Ctx,
  conf: EstadoConfirmacion,
): Promise<{ resultado: ResultadoHerramienta; evento: EventoHerramienta }> {
  const h = deps.herramientas.get(l.nombre)
  const idMensaje = mensajeIdDe(l.args)
  let contenido: string
  let bloqueada = false
  let ejecutada = false

  if (!h) {
    contenido = JSON.stringify({ ok: false, error: `herramienta desconocida: ${l.nombre}` })
  } else {
    const v = h.validar(l.args)
    if (!v.ok) contenido = JSON.stringify({ ok: false, error: v.error })
    else if (l.nombre === "contratos_registrar" && pideConfirmacion(l.args) && idMensaje && !conf.permitidos.has(idMensaje)) {
      bloqueada = true
      conf.pendientes.add(idMensaje)
      contenido = JSON.stringify({
        ok: false,
        error: `confirmación humana no obtenida para ${idMensaje}: el usuario aún no ha visto la solicitud de revisión. Termina el turno mostrándole los campos en revisión y preguntando explícitamente.`,
      })
    } else {
      contenido = await h.ejecutar(l.args, ctx)
      ejecutada = true
    }
  }

  const r = parsearResultado(contenido)
  if (!ejecutada) {
    // La herramienta registra sus propias ejecuciones; aquí se registran las que el ciclo rechazó antes.
    registrarLog(ctx, { ts: ahora(), herramienta: l.nombre, mensaje_id: idMensaje, ok: false, resumen: `${bloqueada ? "[bloqueada] " : "[rechazada] "}${r.error}`, sesion: ctx.sessionId })
  }
  if (idMensaje && l.nombre === "contratos_validar" && r.ok) {
    const revision = Array.isArray(r.data.requiere_revision) ? r.data.requiere_revision : []
    if (revision.length > 0) conf.pendientes.add(idMensaje)
    else conf.pendientes.delete(idMensaje)
  }
  if (idMensaje && l.nombre === "contratos_registrar") {
    if (r.ok) conf.pendientes.delete(idMensaje)
    else if (r.error.startsWith("requiere revisión")) conf.pendientes.add(idMensaje)
  }

  const evento: EventoHerramienta = {
    tipo: "herramienta",
    id: l.id,
    nombre: l.nombre,
    args: l.args,
    ok: r.ok,
    resumen: resumir(l.nombre, contenido),
    resultado: contenido.length > 6000 ? `${contenido.slice(0, 6000)}…` : contenido,
    bloqueada,
    ts: ahora(),
  }
  return { resultado: { id: l.id, nombre: l.nombre, contenido, esError: !r.ok }, evento }
}

// ---------------------------------------------------------------- turno

export async function ejecutarTurno(sesion: Sesion, texto: string, deps: DependenciasCiclo): Promise<ResultadoTurno> {
  const emitir = (e: EventoVista): void => {
    sesion.vista.push(e)
    deps.onEvento?.(e)
  }
  const ctx: Ctx = { directory: deps.directorio, sessionId: sesion.id }
  const conf: EstadoConfirmacion = {
    permitidos: new Set(sesion.confirmacionPendiente),
    pendientes: new Set(sesion.confirmacionPendiente),
  }
  const specs = [...deps.herramientas.values()].map((h) => h.spec)
  const toolCalls: EventoHerramienta[] = []
  const usoTurno = { entrada: 0, salida: 0 }
  const control = new AbortController()

  sesion.mensajes.push({ rol: "usuario", texto })
  emitir({ tipo: "usuario", texto, ts: ahora() })

  let reply = ""
  let iteraciones = 0
  try {
    const system = construirSystemPrompt(deps.directorio)
    let terminado = false
    while (!terminado) {
      const agotado = iteraciones >= deps.maxIteraciones
      const sinPresupuesto = sesion.tokens.entrada + sesion.tokens.salida >= deps.maxTokensSesion
      if (sinPresupuesto) {
        reply = `Se alcanzó el tope de tokens de esta sesión (${deps.maxTokensSesion}). Inicie una sesión nueva para continuar; lo registrado hasta ahora quedó guardado en el maestro.`
        emitir({ tipo: "error", texto: reply, ts: ahora() })
        break
      }
      if (agotado) {
        sesion.mensajes.push({
          rol: "usuario",
          texto: `[sistema] Se alcanzó el tope de ${deps.maxIteraciones} iteraciones de herramientas en este turno. Responde ya, sin llamar herramientas: resume lo que hiciste (solo con datos de las herramientas) y lista lo que falta.`,
        })
      }
      iteraciones++
      deps.onEvento?.({ tipo: "pensando", iteracion: iteraciones })
      const resp = await deps.adaptador.enviar(sesion.mensajes, specs, { system, permitirHerramientas: !agotado, signal: control.signal })
      sesion.tokens.entrada += resp.uso.entrada
      sesion.tokens.salida += resp.uso.salida
      usoTurno.entrada += resp.uso.entrada
      usoTurno.salida += resp.uso.salida

      const llamadas = agotado ? [] : resp.llamadas
      sesion.mensajes.push({ rol: "asistente", texto: resp.texto, llamadas })
      if (llamadas.length === 0) {
        reply = resp.texto.trim() || "(el modelo no devolvió texto)"
        terminado = true
        break
      }
      if (resp.texto.trim()) emitir({ tipo: "asistente", texto: resp.texto.trim(), ts: ahora(), final: false, needsConfirmation: false })

      const resultados: ResultadoHerramienta[] = []
      for (const l of llamadas) {
        const { resultado, evento } = await ejecutarLlamada(l, deps, ctx, conf)
        resultados.push(resultado)
        toolCalls.push(evento)
        emitir(evento)
      }
      sesion.mensajes.push({ rol: "herramienta", resultados })
    }
  } catch (e) {
    reply =
      e instanceof ErrorProveedor
        ? `No pude completar el turno: ${e.message} Lo ya registrado quedó guardado; puede reintentar.`
        : `Error interno del agente: ${e instanceof Error ? e.message : String(e)}. La sesión sigue activa; puede reintentar.`
    emitir({ tipo: "error", texto: reply, ts: ahora() })
  }

  sesion.confirmacionPendiente = [...conf.pendientes]
  const needsConfirmation = conf.pendientes.size > 0
  if (reply && sesion.vista[sesion.vista.length - 1]?.tipo !== "error") {
    emitir({ tipo: "asistente", texto: reply, ts: ahora(), final: true, needsConfirmation })
  }
  return { reply, toolCalls, needsConfirmation, pendientesConfirmacion: [...conf.pendientes], iteraciones, usage: usoTurno }
}
