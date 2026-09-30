/**
 * demo.ts — procesa el buzón llamando directamente a las herramientas, SIN modelo de lenguaje.
 *   bun run demo.ts      |      npx tsx demo.ts      |      npm run demo
 * Limpia out/ al inicio para que el resultado sea determinista (salvo timestamps).
 */
import path from "node:path"
import { fileURLToPath } from "node:url"
import { limpiarSalida } from "./src/tools/almacen"
import * as contratos from "./src/tools/contratos"

const HOY = "2026-09-03"
const ctx = { directory: path.dirname(fileURLToPath(import.meta.url)), sessionId: "demo" }

type Respuesta = { ok: true; data: Record<string, unknown> } | { ok: false; error: string }

async function llamar(nombre: keyof typeof contratos, args: Record<string, unknown>): Promise<Respuesta> {
  const h = contratos[nombre]
  const r = JSON.parse(await h.execute(args, ctx)) as Respuesta
  const estado = r.ok ? "ok" : "error"
  console.log(`   ↳ contratos_${String(nombre)}(${Object.keys(args).join(", ")}) → ${estado}`)
  return r
}

const lista = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])
const texto = (v: unknown): string => (v === null || v === undefined ? "—" : String(v))

const ESPERADO: Record<string, { clasificacion: string; accion1: string; accionFinal: string }> = {
  "msg-001": { clasificacion: "nuevo", accion1: "insertado", accionFinal: "insertado" },
  "msg-002": { clasificacion: "nuevo", accion1: "insertado", accionFinal: "insertado" },
  "msg-003": { clasificacion: "actualizacion", accion1: "actualizado", accionFinal: "actualizado" },
  "msg-004": { clasificacion: "duplicado", accion1: "sin_cambios_duplicado", accionFinal: "sin_cambios_duplicado" },
  "msg-005": { clasificacion: "rechazado", accion1: "rechazado", accionFinal: "rechazado" },
  "msg-006": { clasificacion: "nuevo", accion1: "pendiente_revision", accionFinal: "insertado" },
}
const obtenido: Record<string, { clasificacion: string; accion1: string; accionFinal: string }> = {}

async function procesar(id: string): Promise<Record<string, unknown> | null> {
  console.log(`\n■ ${id}`)
  const ext = await llamar("extraer", { mensaje_id: id })
  if (!ext.ok) {
    console.log(`   ✗ ${ext.error} — se continúa con el siguiente mensaje`)
    return null
  }
  const contrato = ext.data
  const val = await llamar("validar", { mensaje_id: id, contrato })
  if (!val.ok) {
    console.log(`   ✗ ${val.error}`)
    return null
  }
  const revision = lista(val.data.requiere_revision)
  console.log(`   clasificación : ${texto(val.data.clasificacion)}${val.data.motivo ? ` (${texto(val.data.motivo)})` : ""}`)
  console.log(`   en revisión   : ${revision.length ? revision.join(", ") : "ninguno"}`)
  for (const a of lista(val.data.advertencias)) console.log(`   advertencia   : ${a}`)

  const reg = await llamar("registrar", { mensaje_id: id, contrato, hoy: HOY })
  const accion = reg.ok ? texto(reg.data.accion) : "pendiente_revision"
  console.log(`   acción        : ${accion}${reg.ok && reg.data.ruta_archivo ? ` → ${texto(reg.data.ruta_archivo)}` : ""}`)
  if (!reg.ok) console.log(`   (sin registrar) ${reg.error}`)
  obtenido[id] = { clasificacion: texto(val.data.clasificacion), accion1: accion, accionFinal: accion }
  return reg.ok ? null : contrato
}

async function main(): Promise<void> {
  limpiarSalida(ctx)
  console.log(`DEMO · Registro de contratos vigentes · fecha de referencia ${HOY} · sin modelo de lenguaje`)

  console.log("\n1) Buzón")
  const buzon = await llamar("leer_buzon", {})
  const mensajes = buzon.ok && Array.isArray(buzon.data.mensajes) ? (buzon.data.mensajes as Array<Record<string, unknown>>) : []
  for (const m of mensajes) {
    console.log(`   ${texto(m.id)}  ${m.tiene_contrato ? "contrato " : "SIN contrato"}  ${texto(m.de).padEnd(32)} ${texto(m.asunto)}`)
  }

  console.log("\n2) Primera pasada (sin confirmación humana)")
  const pendientes = new Map<string, Record<string, unknown>>()
  for (const m of mensajes) {
    const id = texto(m.id)
    const contrato = await procesar(id)
    if (contrato) pendientes.set(id, contrato)
  }

  console.log("\n3) Segunda pasada: la analista confirma msg-006 (valor 0 por demanda, fecha_fin 2027-08-31)")
  const c6 = pendientes.get("msg-006")
  if (c6) {
    const reg = await llamar("registrar", { mensaje_id: "msg-006", contrato: { ...c6, valor: 0, fecha_fin: "2027-08-31" }, confirmado: true, hoy: HOY })
    if (reg.ok) {
      console.log(`   acción        : ${texto(reg.data.accion)} ${texto(reg.data.id_contrato)} → ${texto(reg.data.ruta_archivo)}`)
      console.log(`   confirmados   : ${lista(reg.data.campos_confirmados).join(", ")}`)
      const o = obtenido["msg-006"]
      if (o) o.accionFinal = texto(reg.data.accion)
    } else console.log(`   ✗ ${reg.error}`)
  }

  console.log("\n4) Alertas")
  const al = await llamar("alertas", { hoy: HOY })
  if (al.ok) {
    console.log(`   ${texto(al.data.ruta)}`)
    for (const v of (al.data.vencen as Array<Record<string, unknown>>) ?? []) console.log(`   vence    ${texto(v.id_contrato)} ${texto(v.cliente)} en ${texto(v.dias)} días (${texto(v.fecha_fin)})`)
    for (const p of (al.data.polizas_pendientes as Array<Record<string, unknown>>) ?? []) console.log(`   póliza   ${texto(p.id_contrato)} ${texto(p.tipo_poliza)} → ${texto(p.estado_poliza)}`)
    for (const g of (al.data.registrados_desde_corte as Array<Record<string, unknown>>) ?? []) console.log(`   gap      ${texto(g.id_contrato)} ${texto(g.accion)} (${texto(g.mensaje_id)})`)
  }

  console.log("\n5) Robustez (HU-6): errores tipados, el lote no se aborta")
  const errores: Array<[keyof typeof contratos, Record<string, unknown>]> = [
    ["extraer", { mensaje_id: "msg-999" }],
    ["validar", { mensaje_id: "msg-002", contrato: { fecha_fin: "2027-02-30" } }],
    ["validar", { mensaje_id: "msg-002", contrato: { moneda: "EUR" } }],
    ["registrar", { mensaje_id: "msg-001", contrato: {} }],
    ["alertas", { hoy: "ayer" }],
  ]
  for (const [nombre, args] of errores) {
    const r = await llamar(nombre, args)
    console.log(`     ${r.ok ? "inesperado: ok" : r.error}`)
  }

  console.log("\n6) Verificación contra el PRD (sección 7.4)")
  let fallos = 0
  for (const [id, esp] of Object.entries(ESPERADO)) {
    const o = obtenido[id]
    const bien = o !== undefined && o.clasificacion === esp.clasificacion && o.accion1 === esp.accion1 && o.accionFinal === esp.accionFinal
    if (!bien) fallos++
    console.log(`   ${bien ? "✔" : "✘"} ${id}: ${o ? `${o.clasificacion} / ${o.accion1}${o.accionFinal !== o.accion1 ? ` → ${o.accionFinal}` : ""}` : "sin resultado"}`)
  }
  console.log(fallos === 0 ? "\nTodo coincide con el resultado esperado." : `\n${fallos} caso(s) no coinciden.`)
  process.exitCode = fallos === 0 ? 0 : 1
}

void main()
