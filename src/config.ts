/**
 * Configuración desde variables de entorno. Las claves se leen aquí y solo se entregan
 * al adaptador del proveedor; nunca se exponen por la API, el front ni los logs.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/** Carga .env si existe (Node no lo hace solo; Bun sí). No sobreescribe variables ya definidas. */
function cargarDotenv(): void {
  const archivo = path.join(RAIZ, ".env")
  if (!fs.existsSync(archivo)) return
  for (const linea of fs.readFileSync(archivo, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(linea)
    if (!m?.[1] || process.env[m[1]] !== undefined) continue
    process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "")
  }
}
cargarDotenv()

function entero(nombre: string, porDefecto: number): number {
  const v = Number(process.env[nombre])
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : porDefecto
}

const proveedor = (process.env.LLM_PROVIDER ?? "anthropic").toLowerCase()
const MODELOS_POR_DEFECTO: Record<string, string> = { anthropic: "claude-sonnet-5-5", openai: "gpt-5-mini", gemini: "gemini-3.6-flash" }

export const CONFIG = {
  puerto: entero("PORT", 3000),
  proveedor,
  modelo: process.env.LLM_MODEL || MODELOS_POR_DEFECTO[proveedor] || "",
  timeoutMs: entero("LLM_TIMEOUT_MS", 60_000),
  // Gemini 3 gasta tokens de salida pensando: por defecto se le da más margen.
  maxTokensRespuesta: entero("LLM_MAX_TOKENS", proveedor === "gemini" ? 8192 : 2048),
  maxIteraciones: entero("MAX_ITERACIONES", 25),
  maxTokensSesion: entero("SESSION_MAX_TOKENS", 400_000),
  claveAcceso: process.env.ACCESS_KEY ?? "",
  openaiBaseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  geminiBaseUrl: process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta",
  geminiNivelPensamiento: process.env.GEMINI_THINKING_LEVEL ?? "low",
  geminiMaxReintentos: entero("GEMINI_MAX_REINTENTOS", 3),
} as const

export function claveProveedor(): string {
  if (CONFIG.proveedor === "anthropic") return process.env.ANTHROPIC_API_KEY ?? ""
  if (CONFIG.proveedor === "openai") return process.env.OPENAI_API_KEY ?? ""
  if (CONFIG.proveedor === "gemini") return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || ""
  return ""
}
