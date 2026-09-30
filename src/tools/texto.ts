/**
 * Utilidades puras de texto, números, fechas y CSV. Sin E/S.
 */

export function sinAcentos(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
}

export function normalizar(s: string): string {
  return sinAcentos(s).toLowerCase().replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim()
}

const SUFIJOS_SOCIETARIOS = /\b(s\.?\s?a\.?\s?s\.?|s\.?\s?a\.?\s?c\.?|s\.?\s?de\s?r\.?\s?l\.?|s\.?\s?a\.?|ltda\.?|e\.?\s?u\.?|s\.?\s?r\.?\s?l\.?)\s*$/i

/** Razón social sin sufijo societario: "Minera Los Andes S.A.C." → "Minera Los Andes". */
export function sinSufijoSocietario(nombre: string): string {
  return nombre.trim().replace(/[.,\s]+$/, ".").replace(SUFIJOS_SOCIETARIOS, "").replace(/[,\s]+$/, "").trim()
}

/** "Universidad del Valle del Río" → "universidad-del-valle-del-rio". */
export function slug(nombre: string): string {
  return normalizar(sinSufijoSocietario(nombre)).replace(/ñ/g, "n").replace(/\s+/g, "-") || "sin-cliente"
}

/** Coeficiente de Dice sobre bigramas de caracteres, en [0, 1]. */
export function similitud(a: string, b: string): number {
  const na = normalizar(a).replace(/\s/g, "")
  const nb = normalizar(b).replace(/\s/g, "")
  if (na === nb) return 1
  if (na.length < 2 || nb.length < 2) return 0
  const bigramas = (s: string): Map<string, number> => {
    const m = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2)
      m.set(bg, (m.get(bg) ?? 0) + 1)
    }
    return m
  }
  const ba = bigramas(na)
  const bb = bigramas(nb)
  let comunes = 0
  for (const [bg, n] of ba) comunes += Math.min(n, bb.get(bg) ?? 0)
  return (2 * comunes) / (na.length - 1 + nb.length - 1)
}

// ---------------------------------------------------------------- números en letras

const PALABRAS_NUMERO: Record<string, number> = {
  cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8,
  nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16,
  diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, veintiun: 21, veintiuno: 21,
  veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26,
  veintisiete: 27, veintiocho: 28, veintinueve: 29, treinta: 30, cuarenta: 40, cincuenta: 50,
  sesenta: 60, setenta: 70, ochenta: 80, noventa: 90, cien: 100, ciento: 100, doscientos: 200,
  doscientas: 200, trescientos: 300, trescientas: 300, cuatrocientos: 400, cuatrocientas: 400,
  quinientos: 500, quinientas: 500, seiscientos: 600, seiscientas: 600, setecientos: 700,
  setecientas: 700, ochocientos: 800, ochocientas: 800, novecientos: 900, novecientas: 900,
}

function esPalabraNumero(t: string): boolean {
  return t in PALABRAS_NUMERO || t === "mil" || t === "millon" || t === "millones"
}

function valorDeTramo(tokens: string[]): number {
  let total = 0
  let actual = 0
  for (const t of tokens) {
    if (t === "y") continue
    if (t === "mil") actual = (actual || 1) * 1000
    else if (t === "millon" || t === "millones") {
      total += (actual || 1) * 1_000_000
      actual = 0
    } else actual += PALABRAS_NUMERO[t] ?? 0
  }
  return total + actual
}

/**
 * Busca el tramo más largo de palabras numéricas en español y devuelve su valor.
 * "DOSCIENTOS SESENTA Y CINCO MILLONES DE PESOS" → 265000000.
 */
export function numeroEnLetras(texto: string): number | null {
  const tokens = normalizar(texto).split(" ")
  let mejor: string[] = []
  let tramo: string[] = []
  const cerrar = (): void => {
    while (tramo.length > 0 && tramo[tramo.length - 1] === "y") tramo.pop()
    if (tramo.length > mejor.length) mejor = tramo
    tramo = []
  }
  for (const t of tokens) {
    if (esPalabraNumero(t) || (t === "y" && tramo.length > 0)) tramo.push(t)
    else cerrar()
  }
  cerrar()
  return mejor.length === 0 ? null : valorDeTramo(mejor)
}

/**
 * Convierte "265.000.000", "120,000.00" o "1.250.000,50" a número.
 * Devuelve null si el formato es ambiguo o inválido.
 */
export function parsearNumero(raw: string): number | null {
  const s = raw.trim().replace(/\s/g, "")
  if (/^\d+$/.test(s)) return Number(s)
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) return Number(s.replace(/\./g, "").replace(",", "."))
  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s)) return Number(s.replace(/,/g, ""))
  if (/^\d+[.,]\d{1,2}$/.test(s)) return Number(s.replace(",", "."))
  return null
}

// ---------------------------------------------------------------- fechas

export const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
}
const PATRON_MES = Object.keys(MESES).join("|")

export function aIso(anio: number, mes: number, dia: number): string {
  return `${anio}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`
}

export function esFechaValida(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return false
  const [anio, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const d = new Date(Date.UTC(anio, mes - 1, dia))
  return d.getUTCFullYear() === anio && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia
}

function desdeIso(iso: string): Date {
  const [a, m, d] = iso.split("-").map(Number)
  return new Date(Date.UTC(a ?? 1970, (m ?? 1) - 1, d ?? 1))
}

function aIsoDate(d: Date): string {
  return aIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
}

export function sumarDias(iso: string, dias: number): string {
  const d = desdeIso(iso)
  d.setUTCDate(d.getUTCDate() + dias)
  return aIsoDate(d)
}

/** Suma meses respetando fin de mes: 2026-01-31 + 1 → 2026-02-28. */
export function sumarMeses(iso: string, meses: number): string {
  const d = desdeIso(iso)
  const dia = d.getUTCDate()
  const destino = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + meses, 1))
  const ultimo = new Date(Date.UTC(destino.getUTCFullYear(), destino.getUTCMonth() + 1, 0)).getUTCDate()
  destino.setUTCDate(Math.min(dia, ultimo))
  return aIsoDate(destino)
}

export function ultimoDiaDelMes(anio: number, mes: number): string {
  const d = new Date(Date.UTC(anio, mes, 0))
  return aIsoDate(d)
}

export function diasEntre(desde: string, hasta: string): number {
  return Math.round((desdeIso(hasta).getTime() - desdeIso(desde).getTime()) / 86_400_000)
}

export interface FechaEncontrada {
  iso: string
  indice: number
  texto: string
}

/** Fechas "el quince (15) de agosto de 2026" o "15 de agosto de 2026", en orden de aparición. */
export function fechasEnTexto(texto: string): FechaEncontrada[] {
  const re = new RegExp(`(?:\\((\\d{1,2})\\)|\\b(\\d{1,2}))\\s+(?:días\\s+del\\s+mes\\s+)?de\\s+(${PATRON_MES})\\s+(?:de|del)\\s+(\\d{4})`, "gi")
  const out: FechaEncontrada[] = []
  for (const m of texto.matchAll(re)) {
    const dia = Number(m[1] ?? m[2])
    const mes = MESES[sinAcentos((m[3] ?? "").toLowerCase())] ?? 0
    const iso = aIso(Number(m[4]), mes, dia)
    if (esFechaValida(iso)) out.push({ iso, indice: m.index ?? 0, texto: m[0] })
  }
  return out
}

/** "en el mes de agosto de 2026" → { anio: 2026, mes: 8 }. */
export function mesSinDia(texto: string): { anio: number; mes: number; texto: string } | null {
  const re = new RegExp(`mes\\s+de\\s+(${PATRON_MES})\\s+de\\s+(\\d{4})`, "i")
  const m = re.exec(texto)
  if (!m) return null
  return { anio: Number(m[2]), mes: MESES[sinAcentos((m[1] ?? "").toLowerCase())] ?? 0, texto: m[0] }
}

/** "doce (12) meses" → 12. */
export function mesesDePlazo(texto: string): number | null {
  const m = /\((\d{1,3})\)\s+meses|\b(\d{1,3})\s+meses/i.exec(texto)
  return m ? Number(m[1] ?? m[2]) : null
}

// ---------------------------------------------------------------- CSV

export function parsearCsv(contenido: string): string[][] {
  const filas: string[][] = []
  let fila: string[] = []
  let campo = ""
  let comillas = false
  for (let i = 0; i < contenido.length; i++) {
    const c = contenido[i]
    if (comillas) {
      if (c === '"' && contenido[i + 1] === '"') {
        campo += '"'
        i++
      } else if (c === '"') comillas = false
      else campo += c
    } else if (c === '"') comillas = true
    else if (c === ",") {
      fila.push(campo)
      campo = ""
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && contenido[i + 1] === "\n") i++
      fila.push(campo)
      if (fila.some((f) => f !== "")) filas.push(fila)
      fila = []
      campo = ""
    } else campo += c
  }
  fila.push(campo)
  if (fila.some((f) => f !== "")) filas.push(fila)
  return filas
}

export function celdaCsv(valor: string): string {
  return /[",\n\r]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor
}

/** Recorta a `max` caracteres sin partir palabras. */
export function recortar(s: string, max: number): string {
  if (s.length <= max) return s
  const corte = s.slice(0, max - 1)
  const espacio = corte.lastIndexOf(" ")
  return `${(espacio > max * 0.6 ? corte.slice(0, espacio) : corte).replace(/[\s,;:.]+$/, "")}…`
}
