/**
 * Implementación de AdaptadorLLM para la API nativa de Google Gemini (generateContent, fetch, sin SDK).
 *
 * Particularidades que resuelve aquí (el ciclo del agente no se entera):
 *  - Gemini 3 devuelve una `thoughtSignature` junto a cada llamada a función y exige recibirla
 *    de vuelta en el historial; se guarda en `LlamadaHerramienta.firma` y se reenvía.
 *  - Las partes de "pensamiento" (`thought: true`) no se muestran como texto de la respuesta.
 *  - La capa gratuita limita peticiones por minuto: ante HTTP 429/503 se reintenta respetando
 *    el `retryDelay` que indica Google (máx. GEMINI_MAX_REINTENTOS veces, espera acotada).
 */
import { z } from "zod"
import {
  ErrorProveedor,
  fetchConTimeout,
  mensajeHttp,
  type AdaptadorLLM,
  type EspecHerramienta,
  type LlamadaHerramienta,
  type Mensaje,
  type OpcionesEnvio,
  type RespuestaLLM,
} from "./adapter"

const ParteSchema = z
  .object({
    text: z.string().optional(),
    thought: z.boolean().optional(),
    thoughtSignature: z.string().optional(),
    functionCall: z.object({ name: z.string(), args: z.unknown().optional(), id: z.string().optional() }).optional(),
  })
  .passthrough()

const RespuestaSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z.object({ parts: z.array(ParteSchema).optional() }).passthrough().optional(),
        finishReason: z.string().optional(),
      }),
    )
    .optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).passthrough().optional(),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().optional(),
      candidatesTokenCount: z.number().optional(),
      thoughtsTokenCount: z.number().optional(),
    })
    .passthrough()
    .optional(),
})

const ErrorSchema = z.object({
  error: z
    .object({
      message: z.string().optional(),
      details: z.array(z.object({ retryDelay: z.string().optional() }).passthrough()).optional(),
    })
    .passthrough(),
})

type ParteGemini =
  | { text: string }
  | { functionCall: { name: string; args: unknown; id?: string }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: Record<string, unknown>; id?: string } }

interface ContenidoGemini {
  role: "user" | "model"
  parts: ParteGemini[]
}

/** functionResponse.response debe ser un objeto JSON; las herramientas devuelven un string JSON. */
function comoObjeto(contenido: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(contenido)
    if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as Record<string, unknown>
    return { resultado: v }
  } catch {
    return { resultado: contenido }
  }
}

function aContenidosGemini(mensajes: Mensaje[]): ContenidoGemini[] {
  const out: ContenidoGemini[] = []
  for (const m of mensajes) {
    if (m.rol === "usuario") out.push({ role: "user", parts: [{ text: m.texto }] })
    else if (m.rol === "asistente") {
      const parts: ParteGemini[] = []
      if (m.texto) parts.push({ text: m.texto })
      for (const l of m.llamadas) {
        parts.push({
          functionCall: { name: l.nombre, args: l.args ?? {}, ...(l.id.startsWith("gem-") ? {} : { id: l.id }) },
          ...(l.firma ? { thoughtSignature: l.firma } : {}),
        })
      }
      out.push({ role: "model", parts: parts.length ? parts : [{ text: "…" }] })
    } else {
      out.push({
        role: "user",
        parts: m.resultados.map((r) => ({
          functionResponse: { name: r.nombre, response: comoObjeto(r.contenido), ...(r.id.startsWith("gem-") ? {} : { id: r.id }) },
        })),
      })
    }
  }
  return out
}

function segundos(retryDelay: string | undefined): number | null {
  const m = retryDelay ? /^([\d.]+)s$/.exec(retryDelay) : null
  return m?.[1] ? Number(m[1]) : null
}

const dormir = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => {
      clearTimeout(t)
      resolve()
    })
  })

export class AdaptadorGemini implements AdaptadorLLM {
  readonly proveedor = "gemini"
  private secuencia = 0

  constructor(
    private readonly clave: string,
    readonly modelo: string,
    private readonly maxTokens: number,
    private readonly timeoutMs: number,
    private readonly baseUrl: string = "https://generativelanguage.googleapis.com/v1beta",
    /** "low" por defecto: el pensamiento consume tokens de salida y cuota. Vacío = no enviar thinkingConfig. */
    private readonly nivelPensamiento: string = "low",
    private readonly maxReintentos: number = 3,
  ) {}

  async enviar(mensajes: Mensaje[], herramientas: EspecHerramienta[], op: OpcionesEnvio): Promise<RespuestaLLM> {
    const cuerpo = {
      systemInstruction: { parts: [{ text: op.system }] },
      contents: aContenidosGemini(mensajes),
      tools: [
        {
          functionDeclarations: herramientas.map((h) => ({ name: h.nombre, description: h.descripcion, parametersJsonSchema: h.parametros })),
        },
      ],
      toolConfig: { functionCallingConfig: { mode: op.permitirHerramientas ? "AUTO" : "NONE" } },
      generationConfig: {
        maxOutputTokens: this.maxTokens,
        ...(this.nivelPensamiento ? { thinkingConfig: { thinkingLevel: this.nivelPensamiento } } : {}),
      },
    }
    const url = `${this.baseUrl}/models/${encodeURIComponent(this.modelo)}:generateContent`
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.clave },
      body: JSON.stringify(cuerpo),
    }

    for (let intento = 0; ; intento++) {
      const res = await fetchConTimeout("Gemini", url, init, this.timeoutMs, op.signal)
      if (res.ok) return this.interpretar(await res.json())

      const error = ErrorSchema.safeParse(await res.json().catch(() => null))
      const detalle = error.success ? error.data.error : undefined
      const reintentable = res.status === 429 || res.status === 503
      if (reintentable && intento < this.maxReintentos && !op.signal.aborted) {
        const sugerido = segundos(detalle?.details?.find((d) => d.retryDelay)?.retryDelay)
        const esperaMs = Math.min((sugerido ?? 2 ** intento * 4) * 1000, 40_000)
        await dormir(esperaMs, op.signal)
        continue
      }
      throw new ErrorProveedor(this.mensajeError(res.status, detalle?.message), res.status)
    }
  }

  private mensajeError(estado: number, mensajeGoogle: string | undefined): string {
    if (estado === 429) {
      return "Gemini: se agotó la cuota de la capa gratuita (HTTP 429) incluso tras reintentar. Espere un minuto o procese menos mensajes por turno."
    }
    // 400 de Google trae un mensaje útil y sin datos sensibles (p. ej. esquema o parámetro no soportado).
    if (estado === 400 && mensajeGoogle) return `Gemini rechazó la petición (HTTP 400): ${mensajeGoogle.slice(0, 300)}`
    if (estado === 403) return "Gemini rechazó la clave (HTTP 403). Revise GEMINI_API_KEY y que la API esté habilitada en AI Studio."
    return mensajeHttp("Gemini", estado)
  }

  private interpretar(json: unknown): RespuestaLLM {
    const parsed = RespuestaSchema.safeParse(json)
    if (!parsed.success) throw new ErrorProveedor("Gemini devolvió una respuesta con formato inesperado.")
    const { candidates, promptFeedback, usageMetadata } = parsed.data
    const candidato = candidates?.[0]
    if (!candidato) {
      throw new ErrorProveedor(`Gemini no devolvió respuesta${promptFeedback?.blockReason ? ` (bloqueada: ${promptFeedback.blockReason})` : ""}.`)
    }
    const partes = candidato.content?.parts ?? []
    const texto = partes
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join("")
    const llamadas: LlamadaHerramienta[] = partes
      .filter((p) => p.functionCall)
      .map((p) => ({
        id: p.functionCall?.id ?? `gem-${++this.secuencia}`,
        nombre: p.functionCall?.name ?? "",
        args: p.functionCall?.args ?? {},
        ...(p.thoughtSignature ? { firma: p.thoughtSignature } : {}),
      }))
    if (!texto && llamadas.length === 0 && candidato.finishReason === "MAX_TOKENS") {
      throw new ErrorProveedor("Gemini agotó el tope de tokens de salida antes de responder. Suba LLM_MAX_TOKENS (p. ej. 8192).")
    }
    return {
      texto,
      llamadas,
      uso: {
        entrada: usageMetadata?.promptTokenCount ?? 0,
        salida: (usageMetadata?.candidatesTokenCount ?? 0) + (usageMetadata?.thoughtsTokenCount ?? 0),
      },
    }
  }
}
