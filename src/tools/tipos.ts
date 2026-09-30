import { z } from "zod"
import { CAMPOS_CON_CONFIANZA, ESTADOS_POLIZA, MONEDAS, PAISES, TIPOS_DOCUMENTO, type CampoConConfianza } from "./reglas"
import { esFechaValida } from "./texto"

const fechaIso = z
  .string()
  .refine(esFechaValida, { message: "fecha inválida: se espera YYYY-MM-DD real (p. ej. 2027-08-31)" })

/**
 * Contrato tal como lo manejan validar/registrar. Todos los campos son opcionales:
 * lo omitido se toma de la extracción determinista del documento. La confianza que
 * envíe el modelo se IGNORA; la única confianza válida es la que calcula la herramienta.
 */
export const ContratoSchema = z
  .object({
    id_contrato: z.string().min(1).max(40).nullable().optional().describe("Número del contrato tal como aparece en el documento"),
    cliente: z.string().min(1).max(200).nullable().optional().describe("Razón social de la contraparte"),
    nit_cliente: z.string().regex(/^\d{5,15}$/, "solo dígitos, sin puntos ni dígito de verificación").nullable().optional().describe("Identificador tributario sin DV ni puntos"),
    pais: z.enum(PAISES).nullable().optional().describe("País de la contraparte"),
    objeto: z.string().min(1).max(200).nullable().optional().describe("Objeto del contrato, máx. 200 caracteres"),
    valor: z.number().nonnegative().nullable().optional().describe("Valor total sin separadores; 0 si es por demanda"),
    valor_indeterminado: z.boolean().optional().describe("true si el contrato es por demanda / sin valor determinado"),
    moneda: z.enum(MONEDAS).nullable().optional().describe("Moneda del valor"),
    fecha_inicio: fechaIso.nullable().optional().describe("YYYY-MM-DD"),
    fecha_fin: fechaIso.nullable().optional().describe("YYYY-MM-DD"),
    requiere_poliza: z.boolean().nullable().optional().describe("Si el contrato exige póliza"),
    tipo_poliza: z.string().max(200).nullable().optional().describe("Tipos de póliza separados por ';'"),
    estado_poliza: z.enum(ESTADOS_POLIZA).nullable().optional().describe("vigente|pendiente|vencida|no_aplica"),
    comercial: z.string().max(120).nullable().optional().describe("Nombre del comercial resuelto"),
    confianza: z.record(z.number()).optional().describe("Ignorado: la confianza la calcula la herramienta"),
  })
  .passthrough()
  .describe("Datos del contrato; use el objeto devuelto por contratos_extraer. Lo omitido se toma de la extracción.")

export type ContratoPropuesto = z.infer<typeof ContratoSchema>

export type Confianzas = Record<CampoConConfianza, number>
export type Evidencias = Partial<Record<CampoConConfianza, string>>

/** Salida de contratos_extraer (esquema 7.2 + confianza por campo). */
export interface ContratoExtraido {
  mensaje_id: string
  archivo: string | null
  tipo_documento: (typeof TIPOS_DOCUMENTO)[number]
  numero_otrosi: number | null
  id_contrato: string | null
  cliente: string | null
  nit_cliente: string | null
  pais: (typeof PAISES)[number] | null
  objeto: string | null
  valor: number | null
  valor_indeterminado: boolean
  moneda: (typeof MONEDAS)[number] | null
  fecha_inicio: string | null
  fecha_fin: string | null
  fecha_firma: string | null
  requiere_poliza: boolean | null
  tipo_poliza: string | null
  estado_poliza: (typeof ESTADOS_POLIZA)[number] | null
  comercial: string | null
  remitente: string
  confianza: Confianzas
  evidencia: Evidencias
  advertencias: string[]
}

/** Campos comparables entre el contrato y la fila del maestro. */
export const CAMPOS_COMPARABLES = [
  "cliente",
  "nit_cliente",
  "pais",
  "objeto",
  "valor",
  "moneda",
  "fecha_inicio",
  "fecha_fin",
  "requiere_poliza",
  "tipo_poliza",
  "estado_poliza",
] as const
export type CampoComparable = (typeof CAMPOS_COMPARABLES)[number]

export function confianzasVacias(): Confianzas {
  const c = {} as Confianzas
  for (const campo of CAMPOS_CON_CONFIANZA) c[campo] = 0
  return c
}

export type Resultado<T> = { ok: true; data: T } | { ok: false; error: string }
