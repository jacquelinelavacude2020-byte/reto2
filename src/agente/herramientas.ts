/**
 * Registro de herramientas: cada export de src/tools/<archivo>.ts se expone como `<archivo>_<export>`.
 * Agregar una herramienta = exportarla en el archivo; el servidor no cambia.
 */
import { z } from "zod"
import type { Ctx } from "../tools/almacen"
import * as contratos from "../tools/contratos"
import type { EspecHerramienta } from "../llm/adapter"
import { objetoAJsonSchema } from "../llm/esquema"

interface Herramienta {
  description: string
  args: z.ZodRawShape
  execute(args: unknown, ctx: Ctx): Promise<string>
}

export interface HerramientaRegistrada {
  nombre: string
  spec: EspecHerramienta
  validar(args: unknown): { ok: true } | { ok: false; error: string }
  ejecutar(args: unknown, ctx: Ctx): Promise<string>
}

function esHerramienta(v: unknown): v is Herramienta {
  return (
    typeof v === "object" &&
    v !== null &&
    "description" in v &&
    typeof v.description === "string" &&
    "args" in v &&
    typeof v.args === "object" &&
    "execute" in v &&
    typeof v.execute === "function"
  )
}

const MODULOS: Record<string, Record<string, unknown>> = { contratos }

export function cargarHerramientas(): Map<string, HerramientaRegistrada> {
  const mapa = new Map<string, HerramientaRegistrada>()
  for (const [archivo, modulo] of Object.entries(MODULOS)) {
    for (const [exportado, valor] of Object.entries(modulo)) {
      if (!esHerramienta(valor)) continue
      const nombre = `${archivo}_${exportado}`
      const esquema = z.object(valor.args).strict()
      mapa.set(nombre, {
        nombre,
        spec: { nombre, descripcion: valor.description, parametros: objetoAJsonSchema(valor.args) },
        validar(args) {
          const r = esquema.safeParse(args ?? {})
          return r.success
            ? { ok: true }
            : { ok: false, error: `argumentos inválidos: ${r.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")}` }
        },
        ejecutar: (args, ctx) => valor.execute(args, ctx),
      })
    }
  }
  return mapa
}
