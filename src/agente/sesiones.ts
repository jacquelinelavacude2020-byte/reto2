/**
 * Sesiones en memoria con respaldo en out/sesiones/<id>.json (sobreviven a un reinicio del proceso).
 */
import fs from "node:fs"
import path from "node:path"
import type { Mensaje } from "../llm/adapter"

export type EventoVista =
  | { tipo: "usuario"; texto: string; ts: string }
  | { tipo: "asistente"; texto: string; ts: string; final: boolean; needsConfirmation: boolean }
  | {
      tipo: "herramienta"
      id: string
      nombre: string
      args: unknown
      ok: boolean
      resumen: string
      resultado: string
      bloqueada: boolean
      ts: string
    }
  | { tipo: "error"; texto: string; ts: string }

export interface Sesion {
  id: string
  creada: string
  mensajes: Mensaje[]
  vista: EventoVista[]
  tokens: { entrada: number; salida: number }
  /** Mensajes del buzón cuya solicitud de confirmación ya se mostró al usuario. */
  confirmacionPendiente: string[]
}

const ID_VALIDO = /^[a-zA-Z0-9_-]{6,64}$/

export class AlmacenSesiones {
  private readonly memoria = new Map<string, Sesion>()
  private readonly ocupadas = new Set<string>()

  constructor(private readonly directorio: string) {}

  esIdValido(id: string): boolean {
    return ID_VALIDO.test(id)
  }

  private archivo(id: string): string {
    return path.join(this.directorio, `${id}.json`)
  }

  obtener(id: string): Sesion | null {
    const enMemoria = this.memoria.get(id)
    if (enMemoria) return enMemoria
    if (!this.esIdValido(id) || !fs.existsSync(this.archivo(id))) return null
    try {
      const s = JSON.parse(fs.readFileSync(this.archivo(id), "utf8")) as Sesion
      this.memoria.set(id, s)
      return s
    } catch {
      return null
    }
  }

  obtenerOCrear(id: string): Sesion {
    const existente = this.obtener(id)
    if (existente) return existente
    const nueva: Sesion = { id, creada: new Date().toISOString(), mensajes: [], vista: [], tokens: { entrada: 0, salida: 0 }, confirmacionPendiente: [] }
    this.memoria.set(id, nueva)
    return nueva
  }

  guardar(s: Sesion): void {
    try {
      fs.mkdirSync(this.directorio, { recursive: true })
      fs.writeFileSync(this.archivo(s.id), JSON.stringify(s), "utf8")
    } catch {
      // La sesión sigue viva en memoria aunque falle el disco.
    }
  }

  /** Evita dos turnos simultáneos sobre la misma sesión. */
  tomar(id: string): boolean {
    if (this.ocupadas.has(id)) return false
    this.ocupadas.add(id)
    return true
  }

  soltar(id: string): void {
    this.ocupadas.delete(id)
  }

  limpiar(): void {
    this.memoria.clear()
  }
}
