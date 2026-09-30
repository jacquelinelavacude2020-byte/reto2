/**
 * Escritura en el maestro simulado de SharePoint (HU-4) y reporte de alertas (HU-5).
 */
import path from "node:path"
import {
  agregarHistorial,
  archivarDocumento,
  escribirArchivoSalida,
  escribirMaestro,
  leerHistorial,
  leerMaestro,
  leerProcesados,
  marcarProcesado,
  type Ctx,
} from "./almacen"
import { evaluar, type Evaluacion } from "./evaluacion"
import { REGLAS, RUTAS, type FilaMaestro } from "./reglas"
import { diasEntre, slug } from "./texto"
import type { ContratoPropuesto } from "./tipos"

export interface ResultadoRegistro {
  mensaje_id: string
  clasificacion: Evaluacion["clasificacion"]
  accion: "insertado" | "actualizado" | "sin_cambios_duplicado" | "rechazado"
  id_contrato: string | null
  ruta_archivo: string | null
  cambios: Array<{ campo: string; antes: string | null; despues: string }>
  confirmado_por_humano: boolean
  campos_confirmados: string[]
  motivo: string | null
  advertencias: string[]
}

function siguienteAuto(maestro: FilaMaestro[], anio: string): string {
  const prefijo = `AUTO-${anio}-`
  const usados = maestro.filter((f) => f.id_contrato.startsWith(prefijo)).map((f) => Number(f.id_contrato.slice(prefijo.length)) || 0)
  return `${prefijo}${String(Math.max(0, ...usados) + 1).padStart(3, "0")}`
}

function rutaDocumento(anio: string, cliente: string, nombreBase: string, archivo: string): string {
  const ext = path.extname(archivo) || ".txt"
  return ["Contratos", anio, slug(cliente), `${nombreBase}${ext}`].join("/")
}

function cerrarSinEscritura(ctx: Ctx, ev: Evaluacion, accion: "sin_cambios_duplicado" | "rechazado", hoyTs: string): ResultadoRegistro {
  marcarProcesado(ctx, ev.mensaje_id, {
    ts: hoyTs,
    clasificacion: ev.clasificacion,
    accion,
    id_contrato: ev.id_contrato_existente ?? ev.contrato.id_contrato,
    motivo: ev.motivo ?? undefined,
  })
  return {
    mensaje_id: ev.mensaje_id,
    clasificacion: ev.clasificacion,
    accion,
    id_contrato: ev.id_contrato_existente ?? ev.contrato.id_contrato,
    ruta_archivo: null,
    cambios: [],
    confirmado_por_humano: false,
    campos_confirmados: [],
    motivo: ev.motivo,
    advertencias: ev.advertencias,
  }
}

function insertar(ctx: Ctx, ev: Evaluacion, hoy: string, confirmado: boolean): ResultadoRegistro {
  const c = ev.contrato
  const maestro = leerMaestro(ctx)
  const anio = (c.fecha_inicio ?? hoy).slice(0, 4)
  const id = c.id_contrato ?? siguienteAuto(maestro, anio)
  const rutaRel = rutaDocumento(anio, c.cliente ?? "sin-cliente", id, ev.extraido.archivo ?? "contrato.txt")
  const fila: FilaMaestro = {
    id_contrato: id,
    cliente: c.cliente ?? "",
    nit_cliente: c.nit_cliente ?? "",
    pais: c.pais ?? "",
    objeto: c.objeto ?? "",
    valor: String(c.valor ?? 0),
    moneda: c.moneda ?? "",
    fecha_inicio: c.fecha_inicio ?? "",
    fecha_fin: c.fecha_fin ?? "",
    requiere_poliza: c.requiere_poliza ? "true" : "false",
    tipo_poliza: c.tipo_poliza ?? "",
    estado_poliza: c.estado_poliza ?? (c.requiere_poliza ? "pendiente" : "no_aplica"),
    comercial: c.comercial ?? "",
    ruta_sharepoint: rutaRel,
    fecha_registro: hoy,
    fuente: "buzon",
  }
  archivarDocumento(ctx, ev.mensaje_id, ev.extraido.archivo ?? "contrato.txt", rutaRel)
  escribirMaestro(ctx, [...maestro, fila])
  const cambios = Object.entries(fila).map(([campo, despues]) => ({ campo, antes: null, despues }))
  return finalizar(ctx, ev, hoy, confirmado, "insertado", id, rutaRel, cambios)
}

function actualizar(ctx: Ctx, ev: Evaluacion, hoy: string, confirmado: boolean): ResultadoRegistro {
  const maestro = leerMaestro(ctx)
  const id = ev.id_contrato_existente ?? ""
  const fila = maestro.find((f) => f.id_contrato === id)
  if (!fila) throw new Error(`el contrato ${id} ya no está en el maestro`)
  const cambios = ev.diferencias.map((d) => ({ campo: d.campo, antes: d.antes, despues: d.despues }))
  for (const d of ev.diferencias) fila[d.campo] = d.despues
  const sufijo = ev.tipo_documento === "otrosi" ? `otrosi-${ev.extraido.numero_otrosi ?? ev.mensaje_id}` : ev.mensaje_id
  const rutaRel = rutaDocumento(fila.fecha_inicio.slice(0, 4), fila.cliente, `${id}_${sufijo}`, ev.extraido.archivo ?? "documento.txt")
  archivarDocumento(ctx, ev.mensaje_id, ev.extraido.archivo ?? "documento.txt", rutaRel)
  escribirMaestro(ctx, maestro)
  return finalizar(ctx, ev, hoy, confirmado, "actualizado", id, rutaRel, cambios)
}

function finalizar(
  ctx: Ctx,
  ev: Evaluacion,
  hoy: string,
  confirmado: boolean,
  accion: "insertado" | "actualizado",
  id: string,
  rutaRel: string,
  cambios: ResultadoRegistro["cambios"],
): ResultadoRegistro {
  const ts = new Date().toISOString()
  agregarHistorial(ctx, {
    ts,
    fecha_operacion: hoy,
    id_contrato: id,
    accion,
    cambios: Object.fromEntries(cambios.map((c) => [c.campo, { antes: c.antes, despues: c.despues }])),
    mensaje_id: ev.mensaje_id,
    confirmado_por_humano: confirmado && ev.requiere_revision.length > 0,
    campos_confirmados: confirmado ? ev.requiere_revision : [],
    documento: rutaRel,
    advertencias: ev.advertencias,
  })
  marcarProcesado(ctx, ev.mensaje_id, { ts, clasificacion: ev.clasificacion, accion, id_contrato: id })
  return {
    mensaje_id: ev.mensaje_id,
    clasificacion: ev.clasificacion,
    accion,
    id_contrato: id,
    ruta_archivo: `${RUTAS.sharepoint}/${rutaRel}`,
    cambios,
    confirmado_por_humano: confirmado && ev.requiere_revision.length > 0,
    campos_confirmados: confirmado ? ev.requiere_revision : [],
    motivo: ev.motivo,
    advertencias: ev.advertencias,
  }
}

export class RequiereRevision extends Error {}

/** HU-4 + RN5: escribe solo si no hay nada en revisión o si el humano confirmó. */
export function registrarContrato(ctx: Ctx, mensajeId: string, propuesto: ContratoPropuesto, confirmado: boolean, hoy: string): ResultadoRegistro {
  const previo = leerProcesados(ctx)[mensajeId]
  if (previo) {
    throw new Error(`el mensaje ${mensajeId} ya fue procesado (${previo.accion}${previo.id_contrato ? ` ${previo.id_contrato}` : ""}); no se vuelve a escribir`)
  }
  const ev = evaluar(ctx, mensajeId, propuesto)
  const ts = new Date().toISOString()
  if (ev.clasificacion === "rechazado") return cerrarSinEscritura(ctx, ev, "rechazado", ts)
  if (ev.clasificacion === "duplicado") return cerrarSinEscritura(ctx, ev, "sin_cambios_duplicado", ts)
  if (ev.requiere_revision.length > 0 && !confirmado) {
    const detalle = ev.detalle_revision.map((d) => `${d.campo}=${d.valor_propuesto ?? "vacío"} (confianza ${d.confianza})`).join("; ")
    throw new RequiereRevision(`requiere revisión: ${ev.requiere_revision.join(", ")}. Detalle: ${detalle}. Pida confirmación al usuario y reintente con confirmado=true.`)
  }
  return ev.clasificacion === "nuevo" ? insertar(ctx, ev, hoy, confirmado) : actualizar(ctx, ev, hoy, confirmado)
}

// ---------------------------------------------------------------- alertas (HU-5)

export interface ItemAlerta {
  id_contrato: string
  cliente: string
  fecha_fin: string
  dias: number
  valor: string
  moneda: string
  comercial: string
}

export interface ReporteAlertas {
  ruta: string
  hoy: string
  vencen: ItemAlerta[]
  vencidos: ItemAlerta[]
  polizas_pendientes: Array<{ id_contrato: string; cliente: string; tipo_poliza: string; estado_poliza: string; fecha_fin: string }>
  registrados_desde_corte: Array<{ id_contrato: string; accion: string; fecha_operacion: string; mensaje_id: string; cliente: string }>
}

function item(f: FilaMaestro, hoy: string): ItemAlerta {
  return { id_contrato: f.id_contrato, cliente: f.cliente, fecha_fin: f.fecha_fin, dias: diasEntre(hoy, f.fecha_fin), valor: f.valor, moneda: f.moneda, comercial: f.comercial }
}

function tabla(encabezados: string[], filas: string[][]): string {
  if (filas.length === 0) return "_Sin elementos._\n"
  const esc = (s: string): string => s.replace(/\|/g, "\\|")
  return [
    `| ${encabezados.join(" | ")} |`,
    `|${encabezados.map(() => "---").join("|")}|`,
    ...filas.map((f) => `| ${f.map(esc).join(" | ")} |`),
  ].join("\n") + "\n"
}

const fmtValor = (v: string, m: string): string => (Number(v) === 0 ? "por demanda" : `${m} ${Number(v).toLocaleString("es-CO")}`)

function markdownAlertas(r: ReporteAlertas): string {
  return [
    `# Alertas de contratos — corte ${r.hoy}`,
    "",
    `Generado a partir de \`${RUTAS.maestro}\`. Ventana de vencimiento: ${REGLAS.diasAlertaVencimiento} días.`,
    "",
    `## 1. Vencen en ≤ ${REGLAS.diasAlertaVencimiento} días (${r.vencen.length})`,
    "",
    tabla(["Contrato", "Cliente", "Fecha fin", "Días", "Valor", "Comercial"], r.vencen.map((v) => [v.id_contrato, v.cliente, v.fecha_fin, String(v.dias), fmtValor(v.valor, v.moneda), v.comercial || "—"])),
    `## 2. Pólizas requeridas no vigentes (${r.polizas_pendientes.length})`,
    "",
    tabla(["Contrato", "Cliente", "Tipo de póliza", "Estado", "Fecha fin contrato"], r.polizas_pendientes.map((p) => [p.id_contrato, p.cliente, p.tipo_poliza.replace(/;/g, ", "), p.estado_poliza, p.fecha_fin])),
    `## 3. Registrados desde el corte del ${REGLAS.fechaCorteMaestro} (gap cubierto: ${r.registrados_desde_corte.length})`,
    "",
    tabla(["Contrato", "Cliente", "Acción", "Fecha", "Mensaje"], r.registrados_desde_corte.map((g) => [g.id_contrato, g.cliente, g.accion, g.fecha_operacion, g.mensaje_id])),
    `## Informativo: contratos ya vencidos sin renovación registrada (${r.vencidos.length})`,
    "",
    tabla(["Contrato", "Cliente", "Fecha fin", "Días vencido"], r.vencidos.map((v) => [v.id_contrato, v.cliente, v.fecha_fin, String(-v.dias)])),
  ].join("\n")
}

export function generarAlertas(ctx: Ctx, hoy: string): ReporteAlertas {
  const maestro = leerMaestro(ctx)
  const conFin = maestro.filter((f) => f.fecha_fin)
  const vencen = conFin.map((f) => item(f, hoy)).filter((i) => i.dias >= 0 && i.dias <= REGLAS.diasAlertaVencimiento).sort((a, b) => a.dias - b.dias)
  const vencidos = conFin.map((f) => item(f, hoy)).filter((i) => i.dias < 0).sort((a, b) => a.dias - b.dias)
  const polizas = maestro
    .filter((f) => f.requiere_poliza === "true" && f.estado_poliza !== "vigente")
    .map((f) => ({ id_contrato: f.id_contrato, cliente: f.cliente, tipo_poliza: f.tipo_poliza, estado_poliza: f.estado_poliza, fecha_fin: f.fecha_fin }))
  const clientePorId = new Map(maestro.map((f) => [f.id_contrato, f.cliente]))
  const desdeCorte = leerHistorial(ctx)
    .filter((h) => h.fecha_operacion >= REGLAS.fechaCorteMaestro)
    .map((h) => ({ id_contrato: h.id_contrato, accion: h.accion, fecha_operacion: h.fecha_operacion, mensaje_id: h.mensaje_id, cliente: clientePorId.get(h.id_contrato) ?? "" }))
  const reporte: ReporteAlertas = { ruta: RUTAS.alertas, hoy, vencen, vencidos, polizas_pendientes: polizas, registrados_desde_corte: desdeCorte }
  escribirArchivoSalida(ctx, RUTAS.alertas, markdownAlertas(reporte))
  return reporte
}

