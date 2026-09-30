/**
 * Conversión mínima de esquemas zod a JSON Schema para declarar herramientas al proveedor.
 * Cubre los tipos que usan las herramientas; evita una dependencia extra.
 */
import { z } from "zod"

type JsonSchema = Record<string, unknown>

function conDescripcion(s: JsonSchema, t: z.ZodTypeAny): JsonSchema {
  return t.description ? { ...s, description: t.description } : s
}

export function zodAJsonSchema(t: z.ZodTypeAny): JsonSchema {
  if (t instanceof z.ZodOptional) return conDescripcion(zodAJsonSchema(t.unwrap()), t)
  if (t instanceof z.ZodDefault) return conDescripcion(zodAJsonSchema(t.removeDefault()), t)
  if (t instanceof z.ZodEffects) return conDescripcion(zodAJsonSchema(t.innerType()), t)
  if (t instanceof z.ZodNullable) {
    const interno = zodAJsonSchema(t.unwrap())
    const tipo = interno.type
    return conDescripcion(typeof tipo === "string" ? { ...interno, type: [tipo, "null"] } : { anyOf: [interno, { type: "null" }] }, t)
  }
  if (t instanceof z.ZodString) return conDescripcion({ type: "string" }, t)
  if (t instanceof z.ZodNumber) return conDescripcion({ type: "number" }, t)
  if (t instanceof z.ZodBoolean) return conDescripcion({ type: "boolean" }, t)
  if (t instanceof z.ZodEnum) return conDescripcion({ type: "string", enum: [...(t.options as string[])] }, t)
  if (t instanceof z.ZodArray) return conDescripcion({ type: "array", items: zodAJsonSchema(t.element) }, t)
  if (t instanceof z.ZodRecord) return conDescripcion({ type: "object", additionalProperties: zodAJsonSchema(t.valueSchema) }, t)
  if (t instanceof z.ZodObject) return conDescripcion(objetoAJsonSchema(t.shape as z.ZodRawShape), t)
  return conDescripcion({}, t)
}

export function objetoAJsonSchema(shape: z.ZodRawShape): JsonSchema {
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []
  for (const [clave, tipo] of Object.entries(shape)) {
    properties[clave] = zodAJsonSchema(tipo)
    if (!tipo.isOptional()) required.push(clave)
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) }
}
