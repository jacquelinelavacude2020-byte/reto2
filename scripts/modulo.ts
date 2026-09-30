/**
 * Genera la carpeta modulo/ (bonus 9.4) a partir de las MISMAS fuentes que usa la aplicación:
 *   agent/prompt.md                      → modulo/agent.md  (frontmatter + cuerpo idéntico)
 *   src/tools/contratos.ts               → modulo/tools/contratos.ts (re-export, no copia)
 *   src/knowledge/registro-contratos.md  → modulo/skill/registro-contratos/SKILL.md
 *
 *   npm run modulo          # regenera
 *   npm run modulo:check    # falla (exit 1) si modulo/ divergió de las fuentes
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..")
const leer = (p: string) => readFileSync(join(RAIZ, p), "utf8")

const prompt = leer("agent/prompt.md").trimEnd()
const conocimiento = leer("src/knowledge/registro-contratos.md").trimEnd()

const archivos: Record<string, string> = {
  "modulo/agent.md": `---
description: Punto único de recepción del buzón de contratos. Clasifica correos, extrae contratos con confianza por campo, valida contra el maestro (RN1–RN7), registra con confirmación humana y genera alertas de vencimiento.
mode: primary
permission:
  edit: deny
  bash: deny
---

<!-- GENERADO por scripts/modulo.ts desde agent/prompt.md. No editar a mano. -->

${prompt}
`,
  "modulo/tools/contratos.ts": `/**
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
`,
  "modulo/skill/registro-contratos/SKILL.md": `---
name: registro-contratos
description: Conocimiento del proceso de registro de contratos vigentes de Periferia IT Group — maestro de SharePoint, reglas de negocio RN1–RN7, clasificación de correos, pólizas, otrosíes y alertas de vencimiento. Úsala al procesar el buzón de contratos.
---

<!-- GENERADO por scripts/modulo.ts desde src/knowledge/registro-contratos.md. No editar a mano. -->

${conocimiento}
`,
}

const check = process.argv.includes("--check")
let divergentes = 0
for (const [ruta, contenido] of Object.entries(archivos)) {
  const abs = join(RAIZ, ruta)
  if (check) {
    const actual = existsSync(abs) ? readFileSync(abs, "utf8") : null
    if (actual !== contenido) {
      divergentes++
      console.error(`✘ ${ruta} no coincide con su fuente`)
    } else console.log(`✔ ${ruta}`)
  } else {
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, contenido)
    console.log(`escrito ${ruta}`)
  }
}
if (check && divergentes) {
  console.error("Ejecute `npm run modulo` para regenerar.")
  process.exit(1)
}
