/**
 * Herramientas del agente de contratos, importables sin el servidor HTTP.
 * GENERADO por scripts/modulo.ts: re-exporta el mismo módulo que usa la aplicación (no es una copia).
 *
 *   import { extraer } from "./modulo/tools/contratos"
 *   const r = await extraer.execute({ mensaje_id: "msg-001" }, { directory: process.cwd(), sessionId: "x" })
 *
 * Cada herramienta expone { description, args (shape zod), execute(args, ctx) → JSON string }:
 * la forma de herramienta personalizada que usan plataformas de agentes tipo OpenCode.
 * ctx.directory es la raíz donde están fixtures/ y out/.
 */
export * from "../../src/tools/contratos"
