/**
 * E/S sobre archivos: buzón (solo lectura), maestro simulado de SharePoint, historial,
 * procesados y log. Todas las rutas se resuelven desde ctx.directory; nunca absolutas.
 */
import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import { COLUMNAS_MAESTRO, RUTAS, type FilaMaestro } from "./reglas"
import { celdaCsv, parsearCsv } from "./texto"

export interface Ctx {
  directory: string
  sessionId: string
}

export function ruta(ctx: Ctx, ...partes: string[]): string {
  const raiz = path.resolve(ctx.directory)
  const destino = path.resolve(raiz, ...partes)
  if (destino !== raiz && !destino.startsWith(raiz + path.sep)) {
    throw new Error(`ruta fuera del proyecto: ${partes.join("/")}`)
  }
  return destino
}

function asegurarDir(archivo: string): void {
  fs.mkdirSync(path.dirname(archivo), { recursive: true })
}

// ---------------------------------------------------------------- buzón

const CorreoSchema = z.object({
  id: z.string(),
  de: z.string(),
  para: z.string().optional(),
  asunto: z.string(),
  fecha: z.string(),
  cuerpo: z.string().default(""),
  adjuntos: z.array(z.string()).default([]),
})
export type Correo = z.infer<typeof CorreoSchema>

const ID_MENSAJE = /^[a-zA-Z0-9_-]{1,64}$/

export function listarIdsBuzon(ctx: Ctx): string[] {
  const dir = ruta(ctx, RUTAS.buzon)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && ID_MENSAJE.test(d.name))
    .map((d) => d.name)
    .sort()
}

export function leerCorreo(ctx: Ctx, mensajeId: string): Correo {
  if (!ID_MENSAJE.test(mensajeId)) throw new Error(`id de mensaje inválido: "${mensajeId}"`)
  const archivo = ruta(ctx, RUTAS.buzon, mensajeId, "correo.json")
  if (!fs.existsSync(archivo)) throw new Error(`no existe el mensaje ${mensajeId} en el buzón`)
  const parsed = CorreoSchema.safeParse(JSON.parse(fs.readFileSync(archivo, "utf8")))
  if (!parsed.success) throw new Error(`correo.json de ${mensajeId} no tiene el formato esperado`)
  return parsed.data
}

export function leerAdjunto(ctx: Ctx, mensajeId: string, nombre: string): string {
  if (nombre.includes("/") || nombre.includes("\\") || nombre.startsWith(".")) {
    throw new Error(`nombre de adjunto inválido: ${nombre}`)
  }
  const archivo = ruta(ctx, RUTAS.buzon, mensajeId, nombre)
  if (!fs.existsSync(archivo)) throw new Error(`el adjunto ${nombre} de ${mensajeId} no existe`)
  return fs.readFileSync(archivo, "utf8")
}

// ---------------------------------------------------------------- comerciales

const ComercialSchema = z.object({ email: z.string(), nombre: z.string(), region: z.string() })
export type Comercial = z.infer<typeof ComercialSchema>

export function leerComerciales(ctx: Ctx): Comercial[] {
  const archivo = ruta(ctx, RUTAS.comerciales)
  return z.array(ComercialSchema).parse(JSON.parse(fs.readFileSync(archivo, "utf8")))
}

// ---------------------------------------------------------------- maestro

/** RN6: la primera operación copia el fixture a out/sharepoint; el fixture nunca se escribe. */
export function asegurarMaestro(ctx: Ctx): string {
  const destino = ruta(ctx, RUTAS.maestro)
  if (!fs.existsSync(destino)) {
    asegurarDir(destino)
    fs.copyFileSync(ruta(ctx, RUTAS.maestroFixture), destino)
  }
  return destino
}

export function leerMaestro(ctx: Ctx): FilaMaestro[] {
  const filas = parsearCsv(fs.readFileSync(asegurarMaestro(ctx), "utf8"))
  const [encabezado, ...datos] = filas
  if (!encabezado) return []
  return datos.map((celdas) => {
    const fila = {} as FilaMaestro
    for (const col of COLUMNAS_MAESTRO) {
      const i = encabezado.indexOf(col)
      fila[col] = i >= 0 ? (celdas[i] ?? "") : ""
    }
    return fila
  })
}

export function escribirMaestro(ctx: Ctx, filas: FilaMaestro[]): void {
  const lineas = [COLUMNAS_MAESTRO.join(",")]
  for (const f of filas) lineas.push(COLUMNAS_MAESTRO.map((c) => celdaCsv(f[c])).join(","))
  const destino = asegurarMaestro(ctx)
  const tmp = `${destino}.tmp`
  fs.writeFileSync(tmp, lineas.join("\n") + "\n", "utf8")
  fs.renameSync(tmp, destino)
}

// ---------------------------------------------------------------- procesados

const ProcesadoSchema = z.object({
  ts: z.string(),
  clasificacion: z.string(),
  accion: z.string(),
  id_contrato: z.string().nullable(),
  motivo: z.string().optional(),
})
export type Procesado = z.infer<typeof ProcesadoSchema>

export function leerProcesados(ctx: Ctx): Record<string, Procesado> {
  const archivo = ruta(ctx, RUTAS.procesados)
  if (!fs.existsSync(archivo)) return {}
  const parsed = z.record(ProcesadoSchema).safeParse(JSON.parse(fs.readFileSync(archivo, "utf8")))
  return parsed.success ? parsed.data : {}
}

export function marcarProcesado(ctx: Ctx, mensajeId: string, p: Procesado): void {
  const actuales = leerProcesados(ctx)
  actuales[mensajeId] = p
  const archivo = ruta(ctx, RUTAS.procesados)
  asegurarDir(archivo)
  fs.writeFileSync(archivo, JSON.stringify(actuales, null, 2), "utf8")
}

// ---------------------------------------------------------------- historial y log

export interface EntradaHistorial {
  ts: string
  fecha_operacion: string
  id_contrato: string
  accion: "insertado" | "actualizado"
  cambios: Record<string, { antes: string | null; despues: string }>
  mensaje_id: string
  confirmado_por_humano: boolean
  campos_confirmados: string[]
  documento: string
  advertencias: string[]
}

export function agregarHistorial(ctx: Ctx, e: EntradaHistorial): void {
  const archivo = ruta(ctx, RUTAS.historial)
  asegurarDir(archivo)
  fs.appendFileSync(archivo, JSON.stringify(e) + "\n", "utf8")
}

export function leerHistorial(ctx: Ctx): EntradaHistorial[] {
  const archivo = ruta(ctx, RUTAS.historial)
  if (!fs.existsSync(archivo)) return []
  return fs
    .readFileSync(archivo, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as EntradaHistorial)
}

export interface EntradaLog {
  ts: string
  herramienta: string
  mensaje_id: string | null
  ok: boolean
  resumen: string
  sesion: string
}

export function registrarLog(ctx: Ctx, e: EntradaLog): void {
  try {
    const archivo = ruta(ctx, RUTAS.log)
    asegurarDir(archivo)
    fs.appendFileSync(archivo, JSON.stringify(e) + "\n", "utf8")
  } catch {
    // El log nunca debe tumbar una herramienta.
  }
}

// ---------------------------------------------------------------- archivo de documentos

export function archivarDocumento(ctx: Ctx, mensajeId: string, adjunto: string, rutaRelativa: string): void {
  const destino = ruta(ctx, RUTAS.sharepoint, rutaRelativa)
  asegurarDir(destino)
  fs.copyFileSync(ruta(ctx, RUTAS.buzon, mensajeId, adjunto), destino)
}

export function escribirArchivoSalida(ctx: Ctx, relativa: string, contenido: string): string {
  const destino = ruta(ctx, relativa)
  asegurarDir(destino)
  fs.writeFileSync(destino, contenido, "utf8")
  return relativa
}

export function leerArchivoSalida(ctx: Ctx, relativa: string): string | null {
  const archivo = ruta(ctx, relativa)
  return fs.existsSync(archivo) ? fs.readFileSync(archivo, "utf8") : null
}

/** Limpia out/ (demo determinista y botón "reiniciar" de la defensa). */
export function limpiarSalida(ctx: Ctx): void {
  fs.rmSync(ruta(ctx, RUTAS.out), { recursive: true, force: true })
}
