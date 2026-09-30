import { CONFIG, claveProveedor } from "../config"
import { ErrorProveedor, type AdaptadorLLM } from "./adapter"
import { AdaptadorAnthropic } from "./anthropic"
import { AdaptadorGemini } from "./gemini"
import { AdaptadorOpenAI } from "./openai"

/** Único punto donde se elige el proveedor. El ciclo del agente recibe un AdaptadorLLM. */
export function crearAdaptador(): AdaptadorLLM {
  const clave = claveProveedor()
  if (!clave) {
    throw new ErrorProveedor(`Falta la clave del proveedor "${CONFIG.proveedor}" en el entorno del backend (ver .env.example).`)
  }
  switch (CONFIG.proveedor) {
    case "anthropic":
      return new AdaptadorAnthropic(clave, CONFIG.modelo, CONFIG.maxTokensRespuesta, CONFIG.timeoutMs)
    case "openai":
      return new AdaptadorOpenAI(clave, CONFIG.modelo, CONFIG.maxTokensRespuesta, CONFIG.timeoutMs, CONFIG.openaiBaseUrl)
    case "gemini":
      return new AdaptadorGemini(
        clave,
        CONFIG.modelo,
        CONFIG.maxTokensRespuesta,
        CONFIG.timeoutMs,
        CONFIG.geminiBaseUrl,
        CONFIG.geminiNivelPensamiento,
        CONFIG.geminiMaxReintentos,
      )
    default:
      throw new ErrorProveedor(`Proveedor no soportado: ${CONFIG.proveedor}. Use anthropic, openai o gemini.`)
  }
}
