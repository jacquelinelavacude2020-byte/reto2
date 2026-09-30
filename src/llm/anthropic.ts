/**
 * Implementación de AdaptadorLLM para la API Messages de Anthropic (fetch, sin SDK).
 */
import { z } from "zod"
import {
  ErrorProveedor,
  fetchConTimeout,
  mensajeHttp,
  type AdaptadorLLM,
  type EspecHerramienta,
  type Mensaje,
  type OpcionesEnvio,
  type RespuestaLLM,
} from "./adapter"

const RespuestaSchema = z.object({
  content: z.array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown() }),
      z.object({ type: z.string() }).passthrough(),
    ]),
  ),
  stop_reason: z.string().nullable().optional(),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).passthrough(),
})

type Bloque =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }

function aMensajesAnthropic(mensajes: Mensaje[]): Array<{ role: "user" | "assistant"; content: Bloque[] }> {
  return mensajes.map((m) => {
    if (m.rol === "usuario") return { role: "user" as const, content: [{ type: "text" as const, text: m.texto }] }
    if (m.rol === "asistente") {
      const bloques: Bloque[] = []
      if (m.texto) bloques.push({ type: "text", text: m.texto })
      for (const l of m.llamadas) bloques.push({ type: "tool_use", id: l.id, name: l.nombre, input: l.args ?? {} })
      return { role: "assistant" as const, content: bloques.length ? bloques : [{ type: "text" as const, text: "…" }] }
    }
    return {
      role: "user" as const,
      content: m.resultados.map((r) => ({ type: "tool_result" as const, tool_use_id: r.id, content: r.contenido, is_error: r.esError })),
    }
  })
}

export class AdaptadorAnthropic implements AdaptadorLLM {
  readonly proveedor = "anthropic"

  constructor(
    private readonly clave: string,
    readonly modelo: string,
    private readonly maxTokens: number,
    private readonly timeoutMs: number,
  ) {}

  async enviar(mensajes: Mensaje[], herramientas: EspecHerramienta[], op: OpcionesEnvio): Promise<RespuestaLLM> {
    const cuerpo = {
      model: this.modelo,
      max_tokens: this.maxTokens,
      // El system prompt es estable entre turnos: se cachea para abaratar las iteraciones.
      system: [{ type: "text", text: op.system, cache_control: { type: "ephemeral" } }],
      messages: aMensajesAnthropic(mensajes),
      tools: herramientas.map((h) => ({ name: h.nombre, description: h.descripcion, input_schema: h.parametros })),
      tool_choice: op.permitirHerramientas ? { type: "auto" } : { type: "none" },
    }
    const res = await fetchConTimeout(
      "Anthropic",
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.clave, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(cuerpo),
      },
      this.timeoutMs,
      op.signal,
    )
    if (!res.ok) throw new ErrorProveedor(mensajeHttp("Anthropic", res.status), res.status)
    const parsed = RespuestaSchema.safeParse(await res.json())
    if (!parsed.success) throw new ErrorProveedor("Anthropic devolvió una respuesta con formato inesperado.")

    let texto = ""
    const llamadas: RespuestaLLM["llamadas"] = []
    for (const b of parsed.data.content) {
      if (b.type === "text" && "text" in b && typeof b.text === "string") texto += b.text
      if (b.type === "tool_use" && "id" in b && "name" in b && typeof b.id === "string" && typeof b.name === "string") {
        llamadas.push({ id: b.id, nombre: b.name, args: "input" in b ? b.input : {} })
      }
    }
    if (parsed.data.stop_reason === "max_tokens" && llamadas.length === 0) {
      texto += "\n\n_(respuesta truncada por el límite de tokens de salida)_"
    }
    return { texto, llamadas, uso: { entrada: parsed.data.usage.input_tokens, salida: parsed.data.usage.output_tokens } }
  }
}
