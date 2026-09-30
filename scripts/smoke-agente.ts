/**
 * Prueba del ciclo del agente con un "modelo" guionizado (sin red ni clave).
 * Verifica: bucle herramienta→modelo, guardia de confirmación humana en el servidor,
 * persistencia de la solicitud entre turnos y tope de iteraciones.
 *   npx tsx scripts/smoke-agente.ts
 */
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ejecutarTurno, type DependenciasCiclo } from "../src/agente/ciclo"
import { cargarHerramientas } from "../src/agente/herramientas"
import type { Sesion } from "../src/agente/sesiones"
import type { AdaptadorLLM, LlamadaHerramienta, Mensaje, RespuestaLLM } from "../src/llm/adapter"
import { limpiarSalida } from "../src/tools/almacen"

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const HOY = "2026-09-03"

/** Devuelve el último resultado de herramienta con ese nombre, parseado. */
function ultimoResultado(mensajes: Mensaje[], nombre: string): Record<string, unknown> | null {
  for (let i = mensajes.length - 1; i >= 0; i--) {
    const m = mensajes[i]
    if (m?.rol !== "herramienta") continue
    const r = m.resultados.find((x) => x.nombre === nombre)
    if (r) {
      const p = JSON.parse(r.contenido) as { ok: boolean; data?: Record<string, unknown> }
      return p.ok && p.data ? p.data : null
    }
  }
  return null
}

let n = 0
const llamada = (nombre: string, args: unknown): LlamadaHerramienta => ({ id: `t${++n}`, nombre, args })
const respuesta = (texto: string, llamadas: LlamadaHerramienta[] = []): RespuestaLLM => ({ texto, llamadas, uso: { entrada: 1000, salida: 100 } })

/** Guion que imita a un modelo obediente, pero que intenta confirmar msg-006 sin preguntar. */
class ModeloGuion implements AdaptadorLLM {
  readonly proveedor = "guion"
  readonly modelo = "guion-v1"
  private paso = 0
  private cola: string[] = []

  async enviar(mensajes: Mensaje[]): Promise<RespuestaLLM> {
    const ultimoUsuario = [...mensajes].reverse().find((m) => m.rol === "usuario")
    const texto = ultimoUsuario?.rol === "usuario" ? ultimoUsuario.texto : ""
    if (texto.startsWith("confirmo")) {
      if (mensajes[mensajes.length - 1]?.rol === "usuario") {
        const c = ultimoResultado(mensajes, "contratos_extraer")
        return respuesta("", [llamada("contratos_registrar", { mensaje_id: "msg-006", contrato: c, confirmado: true, hoy: HOY })])
      }
      const r = ultimoResultado(mensajes, "contratos_registrar")
      return respuesta(`Registrado ${String(r?.id_contrato)} (${String(r?.accion)}).`)
    }
    if (texto.startsWith("bucle")) return respuesta("", [llamada("contratos_consultar_maestro", {})])

    this.paso++
    if (this.paso === 1) return respuesta("Leo el buzón.", [llamada("contratos_leer_buzon", {})])
    if (this.paso === 2) {
      const b = ultimoResultado(mensajes, "contratos_leer_buzon")
      this.cola = Array.isArray(b?.mensajes) ? (b.mensajes as Array<{ id: string }>).map((m) => m.id) : []
    }
    const id = this.cola[0]
    if (!id) {
      if (!ultimoResultado(mensajes, "contratos_alertas")) return respuesta("", [llamada("contratos_alertas", { hoy: HOY })])
      return respuesta("Resumen listo. ¿Confirmas valor 0 y fecha_fin 2027-08-31 para msg-006?")
    }
    const ultimo = mensajes[mensajes.length - 1]
    const ultimaHerr = ultimo?.rol === "herramienta" ? ultimo.resultados[0]?.nombre : ""
    const idPrevio = ultimo?.rol === "herramienta" ? ((JSON.parse(ultimo.resultados[0]?.contenido ?? "{}") as { data?: { mensaje_id?: string } }).data?.mensaje_id ?? null) : null
    if (ultimaHerr !== "contratos_extraer" && ultimaHerr !== "contratos_validar") {
      return respuesta("", [llamada("contratos_extraer", { mensaje_id: id })])
    }
    if (ultimaHerr === "contratos_extraer" && idPrevio === id) {
      return respuesta("", [llamada("contratos_validar", { mensaje_id: id, contrato: ultimoResultado(mensajes, "contratos_extraer") })])
    }
    // tras validar: registrar (el guion "desobedece" en msg-006 y pone confirmado=true sin preguntar)
    this.cola.shift()
    const c = ultimoResultado(mensajes, "contratos_extraer")
    return respuesta("", [llamada("contratos_registrar", { mensaje_id: id, contrato: c, hoy: HOY, ...(id === "msg-006" ? { confirmado: true } : {}) })])
  }
}

function afirmar(condicion: boolean, texto: string): void {
  console.log(`${condicion ? "✔" : "✘"} ${texto}`)
  if (!condicion) process.exitCode = 1
}

async function main(): Promise<void> {
  limpiarSalida({ directory: RAIZ, sessionId: "smoke" })
  const sesion: Sesion = { id: "smoke-001", creada: "", mensajes: [], vista: [], tokens: { entrada: 0, salida: 0 }, confirmacionPendiente: [] }
  const deps: DependenciasCiclo = { adaptador: new ModeloGuion(), herramientas: cargarHerramientas(), directorio: RAIZ, maxIteraciones: 25, maxTokensSesion: 1_000_000 }

  const t1 = await ejecutarTurno(sesion, "Procesa el buzón con fecha de hoy 2026-09-03", deps)
  const bloqueada = t1.toolCalls.find((t) => t.bloqueada)
  afirmar(t1.toolCalls.length >= 15, `turno 1 ejecutó ${t1.toolCalls.length} llamadas a herramientas`)
  afirmar(bloqueada?.args !== undefined && JSON.stringify(bloqueada.args).includes("msg-006"), "el servidor bloqueó confirmado=true de msg-006 sin pregunta previa")
  afirmar(t1.needsConfirmation && t1.pendientesConfirmacion.includes("msg-006"), "turno 1 termina con needsConfirmation para msg-006")

  const t2 = await ejecutarTurno(sesion, "confirmo el valor 0 y la fecha fin 2027-08-31", deps)
  const reg = t2.toolCalls.find((t) => t.nombre === "contratos_registrar")
  afirmar(reg?.ok === true && reg.resumen.includes("CM-2026-03"), `turno 2 registró msg-006: ${reg?.resumen ?? "—"}`)
  afirmar(!t2.needsConfirmation, "turno 2 ya no pide confirmación")

  const t3 = await ejecutarTurno(sesion, "bucle infinito", { ...deps, maxIteraciones: 3 })
  afirmar(t3.iteraciones === 4 && t3.toolCalls.length === 3, `tope de iteraciones respetado (${t3.toolCalls.length} llamadas, respuesta final sin herramientas)`)
  console.log(`\ntokens simulados de la sesión: ${sesion.tokens.entrada} entrada / ${sesion.tokens.salida} salida`)
}

void main()
