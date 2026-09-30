/**
 * Interfaz propia del proveedor de modelo. El ciclo del agente solo conoce estos tipos;
 * cambiar de proveedor = otra implementación de `AdaptadorLLM`, sin tocar el ciclo.
 */

export interface LlamadaHerramienta {
  id: string
  nombre: string
  args: unknown
  /** Dato opaco del proveedor que debe reenviarse tal cual en el historial (p. ej. thoughtSignature de Gemini 3). */
  firma?: string
}

export interface ResultadoHerramienta {
  id: string
  nombre: string
  contenido: string
  esError: boolean
}

export type Mensaje =
  | { rol: "usuario"; texto: string }
  | { rol: "asistente"; texto: string; llamadas: LlamadaHerramienta[] }
  | { rol: "herramienta"; resultados: ResultadoHerramienta[] }

export interface EspecHerramienta {
  nombre: string
  descripcion: string
  /** JSON Schema del objeto de argumentos. */
  parametros: Record<string, unknown>
}

export interface RespuestaLLM {
  texto: string
  llamadas: LlamadaHerramienta[]
  uso: { entrada: number; salida: number }
}

export interface OpcionesEnvio {
  system: string
  /** false = el modelo debe responder solo con texto (se usa al alcanzar el tope de iteraciones). */
  permitirHerramientas: boolean
  signal: AbortSignal
}

export interface AdaptadorLLM {
  readonly proveedor: string
  readonly modelo: string
  enviar(mensajes: Mensaje[], herramientas: EspecHerramienta[], opciones: OpcionesEnvio): Promise<RespuestaLLM>
}

/** Error del proveedor con mensaje apto para mostrarse al usuario (sin claves ni cuerpos crudos). */
export class ErrorProveedor extends Error {
  constructor(
    mensaje: string,
    readonly estado?: number,
  ) {
    super(mensaje)
  }
}

export function mensajeHttp(proveedor: string, estado: number): string {
  if (estado === 401 || estado === 403) return `${proveedor} rechazó la clave de API (HTTP ${estado}). Revise la variable de entorno del backend.`
  if (estado === 404) return `${proveedor} no reconoce el modelo configurado (HTTP 404). Revise LLM_MODEL.`
  if (estado === 429) return `${proveedor} está limitando la tasa de peticiones (HTTP 429). Intente de nuevo en unos segundos.`
  if (estado >= 500) return `${proveedor} tuvo un error interno (HTTP ${estado}). Intente de nuevo.`
  return `${proveedor} devolvió HTTP ${estado}.`
}

/** fetch con timeout; convierte abortos y fallos de red en ErrorProveedor legible. */
export async function fetchConTimeout(
  proveedor: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externo: AbortSignal,
): Promise<Response> {
  const control = new AbortController()
  const temporizador = setTimeout(() => control.abort(), timeoutMs)
  const alAbortar = (): void => control.abort()
  externo.addEventListener("abort", alAbortar)
  try {
    return await fetch(url, { ...init, signal: control.signal })
  } catch (e) {
    if (control.signal.aborted) throw new ErrorProveedor(`${proveedor} no respondió en ${Math.round(timeoutMs / 1000)} s (timeout).`)
    throw new ErrorProveedor(`No se pudo contactar a ${proveedor}: ${e instanceof Error ? e.message : "error de red"}.`)
  } finally {
    clearTimeout(temporizador)
    externo.removeEventListener("abort", alAbortar)
  }
}
