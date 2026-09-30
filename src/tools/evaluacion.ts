/**
 * Reglas RN1–RN5: clasifica un contrato contra el maestro y decide qué requiere revisión.
 * La confianza SIEMPRE es la de la extracción determinista; cualquier valor que el modelo
 * cambie respecto a la extracción se marca como modificado y exige confirmación humana.
 */
import { leerMaestro, type Ctx } from "./almacen"
import { esDocumentoContractual, extraerContrato } from "./extraccion"
import { CAMPOS_CON_CONFIANZA, REGLAS, type CampoConConfianza, type Clasificacion, type FilaMaestro } from "./reglas"
import { normalizar, similitud, slug } from "./texto"
import { CAMPOS_COMPARABLES, type CampoComparable, type ContratoExtraido, type ContratoPropuesto } from "./tipos"

export interface ContratoFinal {
  id_contrato: string | null
  cliente: string | null
  nit_cliente: string | null
  pais: string | null
  objeto: string | null
  valor: number | null
  valor_indeterminado: boolean
  moneda: string | null
  fecha_inicio: string | null
  fecha_fin: string | null
  requiere_poliza: boolean | null
  tipo_poliza: string | null
  estado_poliza: string | null
  comercial: string | null
}

export interface DetalleRevision {
  campo: string
  valor_propuesto: string | null
  confianza: number
  motivo: string
}

export interface Diferencia {
  campo: CampoComparable
  antes: string
  despues: string
}

export interface Evaluacion {
  mensaje_id: string
  tipo_documento: ContratoExtraido["tipo_documento"]
  clasificacion: Clasificacion
  motivo: string | null
  id_contrato_existente: string | null
  requiere_revision: string[]
  detalle_revision: DetalleRevision[]
  diferencias: Diferencia[]
  advertencias: string[]
  contrato: ContratoFinal
  extraido: ContratoExtraido
}

// ---------------------------------------------------------------- representación en el maestro

/** Valor de un campo tal como se escribe en el CSV. */
export function aCelda(campo: CampoComparable | "id_contrato" | "comercial", c: ContratoFinal): string | null {
  const v = c[campo]
  if (v === null || v === undefined) return null
  if (typeof v === "boolean") return v ? "true" : "false"
  return String(v)
}

function mismoValor(campo: CampoComparable, a: string, b: string): boolean {
  if (campo === "tipo_poliza") {
    const conjunto = (s: string): string => s.split(";").map((x) => x.trim()).filter(Boolean).sort().join(";")
    return conjunto(a) === conjunto(b)
  }
  if (campo === "valor") return Number(a) === Number(b)
  if (campo === "cliente" || campo === "objeto") return normalizar(a) === normalizar(b)
  return a === b
}

// ---------------------------------------------------------------- fusión propuesto + extraído

function fusionar(ext: ContratoExtraido, prop: ContratoPropuesto): { final: ContratoFinal; modificados: CampoConConfianza[] } {
  const final: ContratoFinal = {
    id_contrato: ext.id_contrato,
    cliente: ext.cliente,
    nit_cliente: ext.nit_cliente,
    pais: ext.pais,
    objeto: ext.objeto,
    valor: ext.valor,
    valor_indeterminado: prop.valor_indeterminado ?? ext.valor_indeterminado,
    moneda: ext.moneda,
    fecha_inicio: ext.fecha_inicio,
    fecha_fin: ext.fecha_fin,
    requiere_poliza: ext.requiere_poliza,
    tipo_poliza: ext.tipo_poliza,
    estado_poliza: prop.estado_poliza ?? ext.estado_poliza,
    comercial: ext.comercial,
  }
  const modificados: CampoConConfianza[] = []
  for (const campo of CAMPOS_CON_CONFIANZA) {
    const propuesto = prop[campo]
    if (propuesto === undefined) continue
    const actual = final[campo]
    const igual =
      typeof propuesto === "string" && typeof actual === "string"
        ? normalizar(propuesto) === normalizar(actual)
        : propuesto === actual
    if (!igual) {
      modificados.push(campo)
      Object.assign(final, { [campo]: propuesto })
    }
  }
  if (final.requiere_poliza === false) {
    final.tipo_poliza = ""
    final.estado_poliza = "no_aplica"
  } else if (final.requiere_poliza === true && (final.estado_poliza === null || final.estado_poliza === "no_aplica")) {
    final.estado_poliza = "pendiente"
  }
  if (final.valor_indeterminado && final.valor === null) final.valor = 0
  return { final, modificados }
}

// ---------------------------------------------------------------- búsqueda en el maestro

function buscarCoincidencia(maestro: FilaMaestro[], c: ContratoFinal): { fila: FilaMaestro; por: string } | null {
  if (c.id_contrato) {
    const porId = maestro.find((f) => f.id_contrato.toUpperCase() === c.id_contrato?.toUpperCase())
    if (porId) return { fila: porId, por: "id_contrato" }
  }
  if (c.nit_cliente && c.objeto) {
    for (const f of maestro) {
      if (f.nit_cliente !== c.nit_cliente) continue
      const s = similitud(f.objeto, c.objeto)
      if (s >= REGLAS.umbralSimilitudObjeto) return { fila: f, por: `nit_cliente + objeto (similitud ${s.toFixed(2)})` }
    }
  }
  return null
}

function diferenciasCon(fila: FilaMaestro, c: ContratoFinal): Diferencia[] {
  const out: Diferencia[] = []
  for (const campo of CAMPOS_COMPARABLES) {
    const nuevo = aCelda(campo, c)
    if (nuevo === null) continue // null = el documento no lo trae; se conserva el del maestro
    if (!mismoValor(campo, fila[campo], nuevo)) out.push({ campo, antes: fila[campo], despues: nuevo })
  }
  return out
}

/** Diferencias en la identidad de la contraparte: no son una actualización, son un conflicto. */
function conflictosDeIdentidad(fila: FilaMaestro, c: ContratoFinal): DetalleRevision[] {
  const out: DetalleRevision[] = []
  if (c.nit_cliente && c.nit_cliente !== fila.nit_cliente) {
    out.push({ campo: "nit_cliente", valor_propuesto: c.nit_cliente, confianza: 0, motivo: `conflicto con el maestro (${fila.nit_cliente})` })
  }
  if (c.cliente && slug(c.cliente) !== slug(fila.cliente)) {
    out.push({ campo: "cliente", valor_propuesto: c.cliente, confianza: 0, motivo: `conflicto con el maestro (${fila.cliente})` })
  }
  if (c.moneda && c.moneda !== fila.moneda) {
    out.push({ campo: "moneda", valor_propuesto: c.moneda, confianza: 0, motivo: `conflicto con el maestro (${fila.moneda})` })
  }
  if (c.pais && c.pais !== fila.pais) {
    out.push({ campo: "pais", valor_propuesto: c.pais, confianza: 0, motivo: `conflicto con el maestro (${fila.pais})` })
  }
  return out
}

// ---------------------------------------------------------------- revisión (RN5)

function revisionPorConfianza(
  ext: ContratoExtraido,
  final: ContratoFinal,
  campos: readonly CampoConConfianza[],
): DetalleRevision[] {
  const out: DetalleRevision[] = []
  for (const campo of campos) {
    if (campo === "comercial") continue // HU-3: remitente desconocido se reporta, no bloquea
    if (campo === "id_contrato" && final.id_contrato === null) continue // se asigna AUTO-<año>-<seq>
    const conf = ext.confianza[campo]
    if (conf < REGLAS.umbralConfianza) {
      const v = final[campo]
      out.push({
        campo,
        valor_propuesto: v === null ? null : String(v),
        confianza: conf,
        motivo: v === null ? "no se encontró en el documento" : (ext.evidencia[campo] ?? "confianza baja"),
      })
    }
  }
  return out
}

function revisionPorModificacion(ext: ContratoExtraido, final: ContratoFinal, modificados: CampoConConfianza[]): DetalleRevision[] {
  return modificados.map((campo) => ({
    campo,
    valor_propuesto: final[campo] === null ? null : String(final[campo]),
    confianza: 0,
    motivo: `valor distinto al extraído del documento (${ext[campo] === null ? "vacío" : String(ext[campo])}); requiere confirmación humana`,
  }))
}

function unir(...listas: DetalleRevision[][]): DetalleRevision[] {
  const vistos = new Map<string, DetalleRevision>()
  for (const d of listas.flat()) if (!vistos.has(d.campo)) vistos.set(d.campo, d)
  return [...vistos.values()]
}

// ---------------------------------------------------------------- evaluación

function rechazo(ext: ContratoExtraido, final: ContratoFinal, motivo: string): Evaluacion {
  return {
    mensaje_id: ext.mensaje_id,
    tipo_documento: ext.tipo_documento,
    clasificacion: "rechazado",
    motivo,
    id_contrato_existente: null,
    requiere_revision: [],
    detalle_revision: [],
    diferencias: [],
    advertencias: ext.advertencias,
    contrato: final,
    extraido: ext,
  }
}

export function evaluar(ctx: Ctx, mensajeId: string, propuesto: ContratoPropuesto): Evaluacion {
  const ext = extraerContrato(ctx, mensajeId)
  const { final, modificados } = fusionar(ext, propuesto)

  // RN4: sin adjunto de contrato o sin partes/objeto identificables.
  if (!esDocumentoContractual(ext.tipo_documento)) {
    return rechazo(ext, final, `sin adjunto de contrato: ${ext.archivo ?? "sin adjuntos"} es de tipo "${ext.tipo_documento}"`)
  }
  const sinPartes = !final.cliente && !final.nit_cliente
  if (sinPartes || (!final.objeto && ext.tipo_documento === "contrato")) {
    return rechazo(ext, final, "el texto no contiene partes ni objeto identificables")
  }

  const coincidencia = buscarCoincidencia(leerMaestro(ctx), final)
  const porModificacion = revisionPorModificacion(ext, final, modificados)
  const base = {
    mensaje_id: mensajeId,
    tipo_documento: ext.tipo_documento,
    advertencias: [...ext.advertencias],
    contrato: final,
    extraido: ext,
  }

  if (!coincidencia) {
    if (ext.tipo_documento === "otrosi") {
      return rechazo(ext, final, `otrosí de un contrato que no está en el maestro (${final.id_contrato ?? "sin número"}); registre primero el contrato base`)
    }
    const detalle = unir(revisionPorConfianza(ext, final, CAMPOS_CON_CONFIANZA), porModificacion)
    return { ...base, clasificacion: "nuevo", motivo: null, id_contrato_existente: null, requiere_revision: detalle.map((d) => d.campo), detalle_revision: detalle, diferencias: [] }
  }

  const { fila, por } = coincidencia
  const diferencias = diferenciasCon(fila, final)

  // RN1: mismo id y mismos valor, fecha_inicio y fecha_fin → duplicado.
  const mismoId = por === "id_contrato"
  const clave = ["valor", "fecha_inicio", "fecha_fin"] as const
  const claveIgual = clave.every((k) => !diferencias.some((d) => d.campo === k))
  if (mismoId && claveIgual && ext.tipo_documento !== "otrosi") {
    base.advertencias.push(
      diferencias.length > 0
        ? `Duplicado por RN1; otras diferencias ignoradas: ${diferencias.map((d) => d.campo).join(", ")}.`
        : "El documento es idéntico al registro existente.",
    )
    return { ...base, clasificacion: "duplicado", motivo: `ya existe ${fila.id_contrato} con el mismo valor y fechas`, id_contrato_existente: fila.id_contrato, requiere_revision: [], detalle_revision: [], diferencias }
  }

  // RN2: actualización. Solo revisan los campos que cambian + conflictos de identidad.
  const camposQueCambian = diferencias.map((d) => d.campo).filter((c): c is CampoConConfianza & CampoComparable =>
    (CAMPOS_CON_CONFIANZA as readonly string[]).includes(c),
  )
  const detalle = unir(
    conflictosDeIdentidad(fila, final),
    revisionPorConfianza(ext, final, camposQueCambian),
    porModificacion,
  )
  return {
    ...base,
    clasificacion: "actualizacion",
    motivo: `${ext.tipo_documento === "otrosi" ? `otrosí No. ${ext.numero_otrosi ?? "?"}` : "cambios"} sobre ${fila.id_contrato} (coincidencia por ${por})`,
    id_contrato_existente: fila.id_contrato,
    requiere_revision: detalle.map((d) => d.campo),
    detalle_revision: detalle,
    diferencias,
  }
}
