/**
 * Extracción determinista (regex + heurísticas) de un contrato en texto.
 * Cada campo sale con valor, confianza en [0, 1] y evidencia textual.
 * Campo ausente en el texto → null con confianza 0. Nunca se inventa.
 */
import { leerAdjunto, leerComerciales, leerCorreo, type Correo, type Ctx } from "./almacen"
import { REGLAS, type Moneda, type Pais, type TipoDocumento } from "./reglas"
import {
  aIso,
  fechasEnTexto,
  mesSinDia,
  mesesDePlazo,
  normalizar,
  numeroEnLetras,
  parsearNumero,
  recortar,
  sumarDias,
  sumarMeses,
  ultimoDiaDelMes,
} from "./texto"
import { confianzasVacias, type ContratoExtraido } from "./tipos"

// ---------------------------------------------------------------- clasificación de adjuntos

export function clasificarDocumento(nombreArchivo: string, texto: string): TipoDocumento {
  const cabecera = normalizar(texto.slice(0, 200))
  const nombre = normalizar(nombreArchivo)
  if (cabecera.startsWith("otrosi") || nombre.startsWith("otrosi")) return "otrosi"
  if (/^contrato\b/.test(cabecera)) return "contrato"
  if (/^(cotizacion|propuesta|oferta)\b/.test(cabecera) || /cotizacion|propuesta/.test(nombre)) return "cotizacion"
  if (/^contrato/.test(nombre) && cabecera.includes("contrato")) return "contrato"
  return "desconocido"
}

export function esDocumentoContractual(tipo: TipoDocumento): boolean {
  return tipo === "contrato" || tipo === "otrosi"
}

// ---------------------------------------------------------------- utilidades locales

function parrafos(texto: string): string[] {
  return texto
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0)
}

function parrafoCon(ps: string[], re: RegExp): string | null {
  return ps.find((p) => re.test(p)) ?? null
}

type Ext = ContratoExtraido

function fijar<K extends keyof Ext["confianza"]>(
  c: Ext,
  campo: K,
  confianza: number,
  evidencia: string | null,
): void {
  c.confianza[campo] = Math.round(confianza * 100) / 100
  if (evidencia) c.evidencia[campo] = recortar(evidencia, 160)
}

// ---------------------------------------------------------------- identificación

function extraerId(c: Ext, texto: string, titulo: string): void {
  const re = /No\.?\s*([A-Z]{1,5}-\d{4}-\d{1,5})\b/
  const enTitulo = re.exec(titulo)
  const enTexto = enTitulo ?? re.exec(texto)
  if (enTexto?.[1]) {
    c.id_contrato = enTexto[1]
    fijar(c, "id_contrato", enTitulo ? 0.98 : 0.85, enTexto[0])
  } else {
    c.advertencias.push("El documento no trae número de contrato: se asignará AUTO-<año>-<secuencia> al registrar.")
  }
  const otrosi = /OTROS[ÍI]\s+No\.?\s*(\d+)/i.exec(titulo)
  if (otrosi?.[1]) c.numero_otrosi = Number(otrosi[1])
}

interface Parte {
  nombre: string
  tipoId: string
  idNormalizado: string
  indice: number
}

function normalizarId(tipoId: string, raw: string): string {
  const sinPuntos = raw.replace(/\./g, "").trim()
  const sinDv = tipoId === "NIT" && /-\d$/.test(sinPuntos) ? sinPuntos.replace(/-\d$/, "") : sinPuntos
  return sinDv.replace(/\D/g, "")
}

function partes(parrafoPartes: string): Parte[] {
  const re = /([A-ZÁÉÍÓÚÑÜ][A-ZÁÉÍÓÚÑÜ0-9&.,' -]*?),\s+(?:identificad[ao]\s+con\s+)?(NIT|RUC|RTN)\s*(?:No\.?\s*)?(\d[\d.\-]*\d)/g
  const out: Parte[] = []
  for (const m of parrafoPartes.matchAll(re)) {
    const tipoId = m[2] ?? ""
    out.push({
      nombre: (m[1] ?? "").replace(/^Entre\s+(los suscritos,\s*)?/i, "").trim(),
      tipoId,
      idNormalizado: normalizarId(tipoId, m[3] ?? ""),
      indice: m.index ?? 0,
    })
  }
  return out
}

const PALABRAS_MENORES = new Set(["de", "del", "la", "las", "los", "y", "e", "el"])

function tipoTitulo(nombre: string): string {
  return nombre
    .toLowerCase()
    .split(" ")
    .map((w, i) => {
      if (/^(s\.a\.s\.|s\.a\.|s\.a\.c\.|r\.l\.|ltda\.?)$/i.test(w)) return w.toUpperCase()
      if (i > 0 && PALABRAS_MENORES.has(w)) return w
      return w.charAt(0).toUpperCase() + w.slice(1)
    })
    .join(" ")
}

/** Busca el nombre con mayúsculas/minúsculas "naturales" (p. ej. en el bloque de firmas). */
function nombreLegible(texto: string, nombreMayus: string): { nombre: string; enFirmas: boolean } {
  const bajo = texto.toLowerCase()
  const buscado = nombreMayus.toLowerCase()
  let i = bajo.indexOf(buscado)
  while (i >= 0) {
    const candidato = texto.slice(i, i + nombreMayus.length)
    if (candidato !== candidato.toUpperCase()) return { nombre: candidato, enFirmas: true }
    i = bajo.indexOf(buscado, i + 1)
  }
  return { nombre: tipoTitulo(nombreMayus), enFirmas: false }
}

const CIUDADES_PAIS: Array<[RegExp, Pais]> = [
  [/\b(colombia|bogota|medellin|barranquilla|cali|cartagena|bucaramanga)\b/, "CO"],
  [/\b(ecuador|quito|guayaquil|cuenca)\b/, "EC"],
  [/\b(peru|lima|arequipa|trujillo)\b/, "PE"],
  [/\b(panama)\b/, "PA"],
  [/\b(honduras|tegucigalpa|san pedro sula)\b/, "HN"],
]

function paisPorId(tipoId: string, id: string): Pais | null {
  if (tipoId === "NIT") return "CO"
  if (tipoId === "RTN") return "HN"
  if (tipoId === "RUC") return id.length === 13 ? "EC" : id.length === 11 ? "PE" : "PA"
  return null
}

function paisPorTexto(fragmento: string): Pais | null {
  const n = normalizar(fragmento)
  for (const [re, pais] of CIUDADES_PAIS) if (re.test(n)) return pais
  return null
}

function extraerPartes(c: Ext, texto: string, ps: string[]): void {
  const parrafoPartes = parrafoCon(ps, /^Entre\b/i) ?? ps.slice(0, 3).join(" ")
  const cliente = partes(parrafoPartes).find((p) => p.idNormalizado !== REGLAS.nitPropio)
  if (!cliente) return

  const legible = nombreLegible(texto, cliente.nombre)
  c.cliente = legible.nombre
  fijar(c, "cliente", legible.enFirmas ? 0.95 : 0.85, cliente.nombre)

  c.nit_cliente = cliente.idNormalizado
  fijar(c, "nit_cliente", cliente.idNormalizado.length >= 8 ? 0.95 : 0.7, `${cliente.tipoId} ${cliente.idNormalizado}`)

  const contexto = parrafoPartes.slice(cliente.indice, cliente.indice + 260)
  const domicilio = /domicilio en ([^,()]+(?:,\s*[A-ZÁÉÍÓÚ][a-záéíóú]+)?)/.exec(contexto)?.[1] ?? contexto
  const porId = paisPorId(cliente.tipoId, cliente.idNormalizado)
  const porTexto = paisPorTexto(domicilio)
  const pais = porTexto ?? porId
  if (!pais) return
  c.pais = pais
  const conf = porId && porTexto ? (porId === porTexto ? 0.97 : 0.5) : porId === "PA" ? 0.7 : 0.85
  fijar(c, "pais", conf, `${cliente.tipoId} ${cliente.idNormalizado}${porTexto ? ` · domicilio ${domicilio.trim()}` : ""}`)
  if (porId && porTexto && porId !== porTexto) {
    c.advertencias.push(`País inconsistente: el identificador sugiere ${porId} y el domicilio ${porTexto}.`)
  }
}

// ---------------------------------------------------------------- objeto

function extraerObjeto(c: Ext, ps: string[]): void {
  const p = parrafoCon(ps, /\bOBJETO\b\s*\./)
  if (!p) {
    if (c.tipo_documento === "otrosi") c.evidencia.objeto = "El otrosí no redefine el objeto: se conserva el del maestro."
    return
  }
  let objeto = p.replace(/^.*?\bOBJETO\b\s*\.\s*/, "")
  objeto = objeto.replace(/^EL CONTRATISTA\s+(se obliga a|se compromete a|prestará|realizará|ejecutará)\s+/i, "")
  objeto = objeto.replace(/^(ejecutar|realizar|prestar)\s+/i, "").trim()
  if (objeto.length < 10) return
  objeto = objeto.charAt(0).toUpperCase() + objeto.slice(1)
  const truncado = objeto.length > REGLAS.maxCaracteresObjeto
  c.objeto = recortar(objeto, REGLAS.maxCaracteresObjeto)
  fijar(c, "objeto", truncado ? 0.85 : 0.9, p)
}

// ---------------------------------------------------------------- valor y moneda

const MONEDA_POR_PALABRA: Array<[RegExp, Moneda]> = [
  [/\bpesos\b/, "COP"],
  [/\bdolares\b/, "USD"],
  [/\bsoles\b/, "PEN"],
  [/\bbalboas\b/, "PAB"],
  [/\blempiras\b/, "HNL"],
]
const MONEDA_POR_PAIS: Record<Pais, Moneda> = { CO: "COP", EC: "USD", PE: "PEN", PA: "USD", HN: "HNL" }
const RE_INDETERMINADO = /no tiene (un )?valor determinado|valor indeterminado|cuant[ií]a indeterminada|por demanda|sin valor determinado/i

function monedaPorPalabra(fragmento: string): Moneda | null {
  const n = normalizar(fragmento)
  for (const [re, m] of MONEDA_POR_PALABRA) if (re.test(n)) return m
  return null
}

function extraerValor(c: Ext, texto: string, ps: string[]): void {
  const p = parrafoCon(ps, /\bVALOR\b/)
  if (!p) return

  if (RE_INDETERMINADO.test(p)) {
    c.valor = 0
    c.valor_indeterminado = true
    fijar(c, "valor", 0.6, p)
    c.advertencias.push("Valor por demanda: se registra 0 con valor_indeterminado = true; requiere confirmación humana.")
    const codigo = /\b(COP|USD|PEN|PAB|HNL)\b/.exec(texto)
    if (codigo?.[1]) {
      c.moneda = codigo[1] as Moneda
      fijar(c, "moneda", 0.85, `moneda mencionada en el documento: ${codigo[0]}`)
    } else if (c.pais) {
      c.moneda = MONEDA_POR_PAIS[c.pais]
      fijar(c, "moneda", 0.6, `moneda por defecto del país ${c.pais}`)
    }
    return
  }

  const m = /\(?\s*\b(COP|USD|PEN|PAB|HNL)\b\s*\$?\s*([\d][\d.,]*\d)/.exec(p)
  const enLetras = numeroEnLetras(m ? p.slice(0, m.index) : p)
  const numero = m?.[2] ? parsearNumero(m[2]) : null

  if (numero !== null) {
    c.valor = numero
    const coincide = enLetras !== null && enLetras === numero
    const conf = enLetras === null ? 0.9 : coincide ? 0.99 : 0.5
    fijar(c, "valor", conf, m?.[0] ?? p)
    if (enLetras !== null && !coincide) {
      c.advertencias.push(`El valor en letras (${enLetras}) no coincide con el valor en números (${numero}).`)
    }
  } else if (enLetras !== null && enLetras > 0) {
    c.valor = enLetras
    fijar(c, "valor", 0.75, p)
  }

  const porPalabra = monedaPorPalabra(p)
  if (m?.[1]) {
    c.moneda = m[1] as Moneda
    fijar(c, "moneda", porPalabra === null || porPalabra === c.moneda ? 0.97 : 0.5, m[0])
  } else if (porPalabra) {
    c.moneda = porPalabra
    fijar(c, "moneda", 0.85, p)
  }
}

// ---------------------------------------------------------------- plazo

function fechaFirma(ps: string[]): { iso: string | null; mes: { anio: number; mes: number } | null; evidencia: string } | null {
  const p = [...ps].reverse().find((x) => /se firma|firmado|suscrito/i.test(x) && !/^Entre\b/i.test(x))
  if (!p) return null
  const exacta = fechasEnTexto(p)[0]
  if (exacta) return { iso: exacta.iso, mes: null, evidencia: exacta.texto }
  const soloMes = mesSinDia(p)
  if (soloMes) return { iso: null, mes: { anio: soloMes.anio, mes: soloMes.mes }, evidencia: soloMes.texto }
  return null
}

function finPorMeses(inicio: string, meses: number): string {
  return sumarDias(sumarMeses(inicio, meses), -1)
}

function extraerPlazo(c: Ext, ps: string[]): void {
  const firma = fechaFirma(ps)
  if (firma?.iso) c.fecha_firma = firma.iso
  const p = parrafoCon(ps, /\bPLAZO\b/)
  if (!p) return
  const fechas = fechasEnTexto(p)
  const meses = mesesDePlazo(p)
  if (/prorrogable|prórroga/i.test(p)) c.advertencias.push("El contrato tiene prórroga automática: revisar vigencia al vencer.")

  if (c.tipo_documento === "otrosi") {
    const ultima = fechas[fechas.length - 1]
    if (ultima) {
      c.fecha_fin = ultima.iso
      fijar(c, "fecha_fin", 0.95, ultima.texto)
    }
    const suscrito = /suscrito el ([^,]+)/i.exec(ps.find((x) => /suscrito el/i.test(x)) ?? "")
    const inicio = suscrito ? fechasEnTexto(suscrito[0])[0] : undefined
    if (inicio) {
      c.fecha_inicio = inicio.iso
      fijar(c, "fecha_inicio", 0.9, suscrito?.[0] ?? null)
    }
    return
  }

  const [d0, d1] = fechas
  if (d0 && d1 && /desde/i.test(p) && /hasta/i.test(p)) {
    c.fecha_inicio = d0.iso
    c.fecha_fin = d1.iso
    const cuadra = meses === null || finPorMeses(d0.iso, meses) === d1.iso
    fijar(c, "fecha_inicio", 0.95, d0.texto)
    fijar(c, "fecha_fin", cuadra ? (meses === null ? 0.95 : 0.99) : 0.7, d1.texto)
    if (!cuadra) c.advertencias.push(`El plazo de ${meses} meses no cuadra con las fechas desde/hasta.`)
    return
  }

  if (d0 && meses !== null) {
    c.fecha_inicio = d0.iso
    c.fecha_fin = finPorMeses(d0.iso, meses)
    fijar(c, "fecha_inicio", 0.95, d0.texto)
    fijar(c, "fecha_fin", 0.85, `${meses} meses desde ${d0.iso}`)
    return
  }

  if (meses !== null && /firma|suscripci[oó]n/i.test(p) && firma) {
    if (firma.iso) {
      c.fecha_inicio = firma.iso
      c.fecha_fin = finPorMeses(firma.iso, meses)
      fijar(c, "fecha_inicio", 0.85, `firma: ${firma.evidencia}`)
      fijar(c, "fecha_fin", 0.85, `${meses} meses desde la firma (${firma.iso})`)
    } else if (firma.mes) {
      const { anio, mes } = firma.mes
      c.fecha_inicio = aIso(anio, mes, 1)
      const mesFin = sumarMeses(aIso(anio, mes, 1), meses)
      c.fecha_fin = ultimoDiaDelMes(Number(mesFin.slice(0, 4)), Number(mesFin.slice(5, 7)))
      fijar(c, "fecha_inicio", 0.8, `firma sin día: ${firma.evidencia}`)
      fijar(c, "fecha_fin", 0.5, `${meses} meses desde una firma sin día; se propone el último día del mes (criterio conservador)`)
      c.advertencias.push(
        `La firma solo indica "${firma.evidencia}": fecha_inicio se normalizó al día 1 y fecha_fin se propone ${c.fecha_fin} (último día posible del mes); confirmar.`,
      )
    }
  }
}

// ---------------------------------------------------------------- pólizas

const TIPOS_POLIZA: Array<[RegExp, string]> = [
  [/cumplimiento/, "cumplimiento"],
  [/calidad/, "calidad"],
  [/responsabilidad civil/, "responsabilidad_civil"],
  [/salarios|prestaciones sociales/, "salarios_prestaciones"],
  [/estabilidad/, "estabilidad"],
  [/anticipo/, "anticipo"],
  [/seriedad/, "seriedad_oferta"],
]
const RE_CONDICIONAL = /cuyo valor supere|para cada orden|en caso de que|cuando el valor/i

function extraerPoliza(c: Ext, ps: string[], correo: Correo): void {
  const conPoliza = ps.filter((p) => /p[oó]liza|garant[ií]as?\b/i.test(p))
  const cuerpo = normalizar(correo.cuerpo)
  const correoDiceNo = /\b(no (pide|requiere|exige|lleva|necesita)|sin) poliza/.test(cuerpo)
  const correoDiceSi = !correoDiceNo && /(requiere|pide|exige|lleva).{0,20}poliza/.test(cuerpo)

  if (conPoliza.length === 0) {
    c.requiere_poliza = false
    c.tipo_poliza = ""
    c.estado_poliza = "no_aplica"
    const conf = correoDiceSi ? 0.5 : correoDiceNo ? 0.95 : 0.85
    fijar(c, "requiere_poliza", conf, correoDiceNo ? "sin cláusula de garantías; el correo confirma que no pide póliza" : "sin cláusula de garantías ni pólizas")
    fijar(c, "tipo_poliza", conf, null)
    if (correoDiceSi) c.advertencias.push("El correo menciona póliza pero el contrato no trae cláusula de garantías.")
    return
  }

  const texto = normalizar(conPoliza.join(" "))
  const tipos = TIPOS_POLIZA.filter(([re]) => re.test(texto)).map(([, t]) => t)
  const condicional = conPoliza.some((p) => RE_CONDICIONAL.test(p))
  let conf = correoDiceNo ? 0.5 : correoDiceSi ? 0.98 : 0.95
  if (condicional) {
    conf = Math.min(conf, 0.85)
    c.advertencias.push("Póliza condicionada (p. ej. por orden de servicio sobre un monto): se registra como requerida y pendiente.")
  }
  c.requiere_poliza = true
  c.tipo_poliza = tipos.join(";")
  c.estado_poliza = "pendiente"
  fijar(c, "requiere_poliza", conf, conPoliza[0] ?? null)
  fijar(c, "tipo_poliza", tipos.length > 0 ? conf : 0.6, tipos.length > 0 ? tipos.join(", ") : "póliza sin tipo identificable")
  if (c.tipo_documento === "otrosi") {
    c.advertencias.push("El otrosí exige ampliar la vigencia de las garantías: estado_poliza pasa a 'pendiente' hasta recibir la ampliación.")
  }
}

// ---------------------------------------------------------------- comercial

function resolverComercial(c: Ext, ctx: Ctx, correo: Correo): void {
  const email = correo.de.trim().toLowerCase()
  const encontrado = leerComerciales(ctx).find((x) => x.email.toLowerCase() === email)
  if (encontrado) {
    c.comercial = encontrado.nombre
    fijar(c, "comercial", 1, `${email} → ${encontrado.nombre} (${encontrado.region})`)
  } else {
    fijar(c, "comercial", 0, `remitente ${email} no está en comerciales.json`)
    c.advertencias.push(`Remitente no registrado en comerciales.json: ${email}. Se reporta; no bloquea el registro.`)
  }
}

// ---------------------------------------------------------------- orquestación

function contratoVacio(mensajeId: string, correo: Correo): ContratoExtraido {
  return {
    mensaje_id: mensajeId,
    archivo: null,
    tipo_documento: "desconocido",
    numero_otrosi: null,
    id_contrato: null,
    cliente: null,
    nit_cliente: null,
    pais: null,
    objeto: null,
    valor: null,
    valor_indeterminado: false,
    moneda: null,
    fecha_inicio: null,
    fecha_fin: null,
    fecha_firma: null,
    requiere_poliza: null,
    tipo_poliza: null,
    estado_poliza: null,
    comercial: null,
    remitente: correo.de,
    confianza: confianzasVacias(),
    evidencia: {},
    advertencias: [],
  }
}

export interface AdjuntoClasificado {
  nombre: string
  tipo: TipoDocumento
}

export function clasificarAdjuntos(ctx: Ctx, correo: Correo): AdjuntoClasificado[] {
  return correo.adjuntos.map((nombre) => {
    try {
      return { nombre, tipo: clasificarDocumento(nombre, leerAdjunto(ctx, correo.id, nombre)) }
    } catch {
      return { nombre, tipo: "desconocido" as const }
    }
  })
}

export function extraerContrato(ctx: Ctx, mensajeId: string): ContratoExtraido {
  const correo = leerCorreo(ctx, mensajeId)
  const c = contratoVacio(mensajeId, correo)
  resolverComercial(c, ctx, correo)

  const adjuntos = clasificarAdjuntos(ctx, correo)
  const principal = adjuntos.find((a) => esDocumentoContractual(a.tipo))
  if (!principal) {
    const primero = adjuntos[0]
    c.archivo = primero?.nombre ?? null
    c.tipo_documento = primero?.tipo ?? "desconocido"
    c.advertencias.push(
      primero ? `El adjunto ${primero.nombre} no es un contrato (tipo: ${primero.tipo}).` : "El correo no trae adjuntos.",
    )
    return c
  }

  const texto = leerAdjunto(ctx, mensajeId, principal.nombre)
  if (texto.trim().length < 50) throw new Error(`el adjunto ${principal.nombre} está vacío o es ilegible`)
  c.archivo = principal.nombre
  c.tipo_documento = principal.tipo
  const otros = adjuntos.filter((a) => a !== principal && esDocumentoContractual(a.tipo))
  if (otros.length > 0) {
    c.advertencias.push(`El correo trae ${otros.length + 1} documentos contractuales; se procesó ${principal.nombre}. Pida al comercial un correo por contrato: ${otros.map((a) => a.nombre).join(", ")}.`)
  }

  const ps = parrafos(texto)
  const titulo = ps[0] ?? ""
  extraerId(c, texto, titulo)
  extraerPartes(c, texto, ps)
  extraerObjeto(c, ps)
  extraerValor(c, texto, ps)
  extraerPlazo(c, ps)
  extraerPoliza(c, ps, correo)

  if (c.fecha_inicio && c.fecha_fin && c.fecha_fin < c.fecha_inicio) {
    fijar(c, "fecha_fin", 0.3, null)
    c.advertencias.push(`fecha_fin (${c.fecha_fin}) es anterior a fecha_inicio (${c.fecha_inicio}).`)
  }
  return c
}

