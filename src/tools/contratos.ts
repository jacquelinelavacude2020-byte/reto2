/**
 * Herramientas del agente "Registro de Contratos Vigentes".
 * Cada export es una herramienta; el modelo la ve como `contratos_<export>`.
 * Contrato: { description, args (zod), execute(args, ctx) → string JSON { ok, data | error } }.
 * Nunca lanzan: todo error se devuelve como { ok: false, error } legible.
 * Son importables sin el servidor (demo.ts y modulo/ las usan tal cual).
 */
import { z } from "zod"
import { leerCorreo, leerMaestro, leerProcesados, listarIdsBuzon, registrarLog, type Ctx } from "./almacen"
import { evaluar } from "./evaluacion"
import { clasificarAdjuntos, esDocumentoContractual, extraerContrato } from "./extraccion"
import { generarAlertas, registrarContrato } from "./operaciones"
import { ContratoSchema } from "./tipos"
import { esFechaValida } from "./texto"

export type { Ctx }

const fecha = (descripcion: string) =>
  z.string().refine(esFechaValida, { message: "fecha inválida: use YYYY-MM-DD real" }).describe(descripcion)

const mensajeId = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, "id de mensaje inválido").describe("Id del mensaje del buzón, p. ej. msg-001")

// ---------------------------------------------------------------- envoltorio común

interface Salida<T> {
  data: T
  resumen: string
}

function herramienta<S extends z.ZodRawShape, T>(
  nombre: string,
  description: string,
  args: S,
  fn: (a: z.infer<z.ZodObject<S>>, ctx: Ctx) => Salida<T>,
) {
  const esquema = z.object(args).strict()
  return {
    description,
    args,
    async execute(entrada: unknown, ctx: Ctx): Promise<string> {
      const parsed = esquema.safeParse(entrada ?? {})
      const idMensaje = typeof entrada === "object" && entrada !== null && "mensaje_id" in entrada ? String(entrada.mensaje_id) : null
      const log = (ok: boolean, resumen: string): void =>
        registrarLog(ctx, { ts: new Date().toISOString(), herramienta: `contratos_${nombre}`, mensaje_id: idMensaje, ok, resumen, sesion: ctx.sessionId })
      if (!parsed.success) {
        const error = `argumentos inválidos: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")}`
        log(false, error)
        return JSON.stringify({ ok: false, error })
      }
      try {
        const { data, resumen } = fn(parsed.data, ctx)
        log(true, resumen)
        return JSON.stringify({ ok: true, data })
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        log(false, error)
        return JSON.stringify({ ok: false, error })
      }
    },
  }
}

const hoyIso = (): string => new Date().toISOString().slice(0, 10)

// ---------------------------------------------------------------- HU-1

export const leer_buzon = herramienta(
  "leer_buzon",
  "Lista los mensajes pendientes del buzón de contratos (no procesados) con remitente, asunto, adjuntos y si traen contrato.",
  {},
  (_a, ctx) => {
    const procesados = leerProcesados(ctx)
    const mensajes = listarIdsBuzon(ctx)
      .filter((id) => !procesados[id])
      .map((id) => {
        const correo = leerCorreo(ctx, id)
        const adjuntos = clasificarAdjuntos(ctx, correo)
        const tieneContrato = adjuntos.some((a) => esDocumentoContractual(a.tipo))
        return {
          id: correo.id,
          de: correo.de,
          asunto: correo.asunto,
          fecha: correo.fecha,
          adjuntos: correo.adjuntos,
          tipos_adjuntos: adjuntos.map((a) => `${a.nombre}: ${a.tipo}`),
          tiene_contrato: tieneContrato,
          ...(tieneContrato
            ? {}
            : { clasificacion: "rechazado" as const, motivo: `sin adjunto de contrato (${adjuntos.map((a) => a.tipo).join(", ") || "sin adjuntos"})` }),
        }
      })
    return {
      data: { mensajes, ya_procesados: Object.keys(procesados) },
      resumen: `${mensajes.length} pendientes (${mensajes.filter((m) => !m.tiene_contrato).length} sin contrato)`,
    }
  },
)

// ---------------------------------------------------------------- HU-2

export const extraer = herramienta(
  "extraer",
  "Extrae de forma determinista los datos del contrato adjunto a un mensaje, con confianza [0,1] y evidencia por campo.",
  { mensaje_id: mensajeId },
  (a, ctx) => {
    const c = extraerContrato(ctx, a.mensaje_id)
    const bajos = Object.entries(c.confianza).filter(([k, v]) => k !== "comercial" && v < 0.8).map(([k]) => k)
    return { data: c, resumen: `${c.tipo_documento} ${c.id_contrato ?? "sin id"}; confianza baja: ${bajos.join(", ") || "ninguna"}` }
  },
)

// ---------------------------------------------------------------- HU-3

export const validar = herramienta(
  "validar",
  "Clasifica el contrato frente al maestro (nuevo, actualizacion, duplicado, rechazado) y lista los campos que requieren revisión humana.",
  { mensaje_id: mensajeId, contrato: ContratoSchema },
  (a, ctx) => {
    const ev = evaluar(ctx, a.mensaje_id, a.contrato)
    const { extraido: _omitido, ...data } = ev
    return {
      data,
      resumen: `${ev.clasificacion}${ev.requiere_revision.length ? `; revisión: ${ev.requiere_revision.join(", ")}` : ""}`,
    }
  },
)

// ---------------------------------------------------------------- HU-4

export const registrar = herramienta(
  "registrar",
  "Registra o actualiza el contrato en el maestro de SharePoint, archiva el documento y marca el mensaje como procesado; exige confirmado=true si hay campos en revisión.",
  {
    mensaje_id: mensajeId,
    contrato: ContratoSchema,
    confirmado: z.boolean().optional().describe("true SOLO si el usuario confirmó explícitamente los campos en revisión en su último mensaje"),
    hoy: fecha("Fecha de referencia del registro (YYYY-MM-DD); por defecto la fecha del servidor").optional(),
  },
  (a, ctx) => {
    const r = registrarContrato(ctx, a.mensaje_id, a.contrato, a.confirmado ?? false, a.hoy ?? hoyIso())
    return { data: r, resumen: `${r.accion} ${r.id_contrato ?? ""}`.trim() }
  },
)

// ---------------------------------------------------------------- HU-5

export const alertas = herramienta(
  "alertas",
  "Genera out/alertas.md con contratos que vencen en ≤60 días, pólizas requeridas no vigentes y registros desde el corte del maestro.",
  { hoy: fecha("Fecha de referencia del reporte (YYYY-MM-DD)") },
  (a, ctx) => {
    const r = generarAlertas(ctx, a.hoy)
    return {
      data: r,
      resumen: `vencen ${r.vencen.length}, pólizas pendientes ${r.polizas_pendientes.length}, desde corte ${r.registrados_desde_corte.length}`,
    }
  },
)

// ---------------------------------------------------------------- consulta

export const consultar_maestro = herramienta(
  "consultar_maestro",
  "Consulta filas del maestro de contratos por id, texto de cliente/objeto o fecha de vencimiento máxima.",
  {
    id_contrato: z.string().max(40).optional().describe("Id exacto del contrato"),
    texto: z.string().max(100).optional().describe("Texto a buscar en cliente u objeto"),
    vencen_antes_de: fecha("Solo contratos con fecha_fin menor o igual a esta fecha").optional(),
  },
  (a, ctx) => {
    const q = a.texto?.toLowerCase()
    const filas = leerMaestro(ctx).filter(
      (f) =>
        (!a.id_contrato || f.id_contrato.toUpperCase() === a.id_contrato.toUpperCase()) &&
        (!q || f.cliente.toLowerCase().includes(q) || f.objeto.toLowerCase().includes(q)) &&
        (!a.vencen_antes_de || (f.fecha_fin !== "" && f.fecha_fin <= a.vencen_antes_de)),
    )
    return { data: { total: filas.length, filas: filas.slice(0, 50) }, resumen: `${filas.length} filas` }
  },
)
