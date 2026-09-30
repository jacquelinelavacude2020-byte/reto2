/**
 * Implementación alternativa para la API Chat Completions de OpenAI (o compatibles, vía OPENAI_BASE_URL).
 * Existe para demostrar que cambiar de proveedor no toca el ciclo del agente.
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
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }) }))
            .nullable()
            .optional(),
        }),
      }),
    )
    .min(1),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).passthrough().optional(),
})

type MensajeOpenAI =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string }

function aMensajesOpenAI(system: string, mensajes: Mensaje[]): MensajeOpenAI[] {
  const out: MensajeOpenAI[] = [{ role: "system", content: system }]
  for (const m of mensajes) {
    if (m.rol === "usuario") out.push({ role: "user", content: m.texto })
    else if (m.rol === "asistente") {
      out.push({
        role: "assistant",
        content: m.texto || null,
        ...(m.llamadas.length
          ? { tool_calls: m.llamadas.map((l) => ({ id: l.id, type: "function" as const, function: { name: l.nombre, arguments: JSON.stringify(l.args ?? {}) } })) }
          : {}),
      })
    } else for (const r of m.resultados) out.push({ role: "tool", tool_call_id: r.id, content: r.contenido })
  }
  return out
}

function parsearArgs(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return { __error: "argumentos no son JSON válido", raw }
  }
}

export class AdaptadorOpenAI implements AdaptadorLLM {
  readonly proveedor = "openai"

  constructor(
    private readonly clave: string,
    readonly modelo: string,
    private readonly maxTokens: number,
    private readonly timeoutMs: number,
    private readonly baseUrl: string = "https://api.openai.com/v1",
  ) {}

  async enviar(mensajes: Mensaje[], herramientas: EspecHerramienta[], op: OpcionesEnvio): Promise<RespuestaLLM> {
    const cuerpo = {
      model: this.modelo,
      max_completion_tokens: this.maxTokens,
      messages: aMensajesOpenAI(op.system, mensajes),
      tools: herramientas.map((h) => ({ type: "function", function: { name: h.nombre, description: h.descripcion, parameters: h.parametros } })),
      tool_choice: op.permitirHerramientas ? "auto" : "none",
    }
    const res = await fetchConTimeout(
      "OpenAI",
      `${this.baseUrl}/chat/completions`,
      { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.clave}` }, body: JSON.stringify(cuerpo) },
      this.timeoutMs,
      op.signal,
    )
    if (!res.ok) throw new ErrorProveedor(mensajeHttp("OpenAI", res.status), res.status)
    const parsed = RespuestaSchema.safeParse(await res.json())
    if (!parsed.success) throw new ErrorProveedor("OpenAI devolvió una respuesta con formato inesperado.")
    const msg = parsed.data.choices[0]?.message
    return {
      texto: msg?.content ?? "",
      llamadas: (msg?.tool_calls ?? []).map((t) => ({ id: t.id, nombre: t.function.name, args: parsearArgs(t.function.arguments) })),
      uso: { entrada: parsed.data.usage?.prompt_tokens ?? 0, salida: parsed.data.usage?.completion_tokens ?? 0 },
    }
  }
}
