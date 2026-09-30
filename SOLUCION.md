# SOLUCIÓN · Agente «Registro de Contratos Vigentes»

## 1. Problema en una frase

Desde el 30 de mayo de 2026 nadie alimenta el maestro de contratos, porque solo llegan a administración los que requieren póliza y no existe un punto único de recepción. Esto le duele a tres actores:

- **La analista administrativa**, dueña del maestro, que no puede mantenerlo ni hacer seguimiento a las pólizas.
- **Gerencia**, que no sabe qué contratos vencen ni qué riesgo está abierto.
- **La empresa**, porque el proceso murió cuando se fue la única persona que lo hacía.

## 2. Arquitectura

```
 Navegador (web/)                     Backend (src/server.ts, node:http)
 ┌──────────────────────┐   POST /api/chat?stream=1   ┌──────────────────────────────────────┐
 │ chat + "pensando"    │ ──────────────────────────▶ │ sesiones (memoria + out/sesiones/)   │
 │ llamadas a           │ ◀────── eventos SSE ─────── │ ACCESS_KEY opcional, 20 msg/min/IP   │
 │ herramientas         │                             │                                      │
 │ sello "Requiere tu   │                             │ ciclo del agente (src/agente/)       │
 │ confirmación"        │                             │   ├─ prompt: agent/prompt.md         │
 │ panel maestro/alertas│                             │   │          + src/knowledge/*.md    │
 └──────────────────────┘                             │   ├─ adaptador LLM (src/llm/)        │
                                                      │   │   gemini · anthropic · openai    │
                                                      │   └─ herramientas zod (src/tools/)   │
                                                      └──────────────────┬───────────────────┘
                                                                         │
                         fixtures/reto-02/  ◀── solo lectura ────────────┤
                         (buzón, maestro, comerciales)                   │
                                                                         ▼  escritura
                         out/sharepoint/maestro-contratos.csv   (copia de trabajo, RN6)
                         out/sharepoint/Contratos/<año>/<cliente>/<id>.txt
                         out/sharepoint/historial.jsonl · out/procesados.json
                         out/log.jsonl (RN7) · out/alertas.md
```

Separé las responsabilidades como pide el PRD:

| Qué | Dónde | Contenido |
|---|---|---|
| Comportamiento | `agent/prompt.md` | Rol, reglas que el agente no puede romper y procedimiento para «procesa el buzón». |
| Conocimiento | `src/knowledge/registro-contratos.md` | Esquema del maestro, RN1–RN7, cómo leer la confianza, alertas y glosario. Se relee en cada turno. |
| Ejecución | `src/tools/` | Toda la lógica de negocio, determinista. Los umbrales (0.8, 0.9, 60 días, fecha de corte) están en `reglas.ts`. |
| Proveedor | `src/llm/` | Interfaz propia `enviar()`, con tres implementaciones. |

El servidor no conoce ninguna regla de negocio. Las herramientas no dependen del servidor, así que `demo.ts` y `modulo/` las importan directamente.

## 3. Ciclo del agente

Cada turno (`src/agente/ciclo.ts`) funciona así:

1. Armo el `system` uniendo el prompt con el conocimiento, y envío el historial al modelo.
2. Si el modelo pide herramientas, cada llamada pasa por estos pasos en orden:
   - la **valido con zod** antes de ejecutarla; si los argumentos no cumplen, el error vuelve al modelo;
   - pasa por la **guardia de confirmación** (explicada abajo);
   - se ejecuta;
   - se muestra en el chat y queda en `out/log.jsonl`.
3. Repito hasta que el modelo responde sin pedir herramientas, o hasta el **tope de 25 iteraciones**. Al llegar al tope hago una última llamada sin herramientas para que resuma qué hizo y qué falta. El usuario nunca se queda sin respuesta.
4. Hay un **tope de tokens por sesión** (`SESSION_MAX_TOKENS`) para que nadie pueda gastar la clave sin límite.
5. Los errores del proveedor se muestran en español y la sesión sigue viva. Esto incluye timeout, clave inválida, cuota agotada y errores internos. Lo que ya se registró en ese turno queda guardado.

**Confirmación humana en tres capas.** No me bastaba con pedírselo al modelo en el prompt.

| Capa | Qué hace |
|---|---|
| Herramienta | `contratos_registrar` se niega a escribir si hay campos con confianza < 0.8, o si el contrato difiere de lo extraído, y no viene `confirmado: true`. |
| Servidor | Solo acepta `confirmado: true` para un mensaje que quedó pendiente en un turno **anterior**, es decir, cuando el usuario ya vio la pregunta. Si el modelo intenta confirmar por su cuenta, la llamada se bloquea y queda en el log como `[bloqueada]`. |
| Front | La respuesta llega con `needsConfirmation: true`. El mensaje se marca con un sello rojo y aparecen los botones «Confirmar lo propuesto» y «Corregir un valor». |

## 4. Elección del modelo y costo

**Para la demo uso Google `gemini-3.6-flash` en la capa gratuita.** El proveedor se cambia con una variable de entorno; también funcionan Anthropic (`claude-sonnet-5-5`) y OpenAI.

Por qué un modelo de gama Flash alcanza:

- En esta solución **el modelo no extrae datos**; eso lo hacen las herramientas.
- Su trabajo es llamar las herramientas en orden, no inventar valores, detenerse a preguntar y resumir en español.
- Por eso, la calidad del dato registrado no depende del modelo elegido.

El adaptador de Gemini resuelve cuatro particularidades sin tocar el ciclo:

- reenvía la «firma de pensamiento» que Gemini 3 exige en cada llamada a herramienta;
- oculta las partes de pensamiento del modelo;
- limita el pensamiento al nivel `low` y da 8.192 tokens de salida;
- ante un error 429 de cuota, reintenta respetando el tiempo de espera que indica Google.

**Costo estimado por caso:**

| Concepto | Valor aproximado |
|---|---|
| Prompt + conocimiento + esquemas de herramientas | ~4.000 tokens por llamada |
| Resultados de herramientas por mensaje del buzón | ~900 tokens |
| Salida del modelo por mensaje | ~1.000 tokens |
| Llamadas al modelo por lote completo (6 mensajes + alertas + confirmación) | ~22 |

| Modelo | Costo por lote | Costo por caso |
|---|---|---|
| Gemini 3.6 Flash, capa gratuita | US$ 0 (dentro de la cuota) | US$ 0 |
| Claude Sonnet 5.5 ($2 / $10 por millón; caché a $0.20) | ≈ US$ 0,36 | ≈ US$ 0,06 |
| Claude Haiku 4.5 ($1 / $5 por millón) | ≈ US$ 0,18 | ≈ US$ 0,03 |

Los precios son públicos, consultados el 30-09-2026. A un volumen realista de unos 40 contratos al mes, el costo de producción queda por debajo de US$ 3 mensuales. El consumo real de cada sesión se ve en vivo en el encabezado del chat.

**Limitación de la capa gratuita:** Google puede usar esos datos para mejorar sus productos. Es aceptable con fixtures ficticios; con contratos reales usaría un plan de pago con retención cero.

## 5. Estrategia de extracción

Toda la extracción está en `src/tools/extraccion.ts`, **sin modelo**: expresiones regulares y reglas sobre los párrafos del contrato. Cada campo guarda su valor, su confianza y la evidencia, que es el fragmento de texto que lo justifica.

| Campo | Cómo lo encuentro | Confianza |
|---|---|---|
| Tipo de documento | Nombre del adjunto y encabezado (contrato, contrato marco, otrosí, cotización…). | — |
| `id_contrato` | Patrón `CT-`/`CM-AAAA-NNN`. Si no aparece, `AUTO-<año>-<secuencia>`. | 0.98 en el título; 0.85 solo en el cuerpo |
| Cliente, NIT, país | Párrafo de partes («entre … y …»). Descarto a Periferia por su NIT. El tipo de identificador (NIT, RUC, RTN) indica el país y lo cruzo con el domicilio. | 0.95–0.97; 0.5 si se contradicen |
| Objeto | Cláusula de objeto, recortada a 200 caracteres sin cortar palabras. | 0.9 (0.85 si se recortó) |
| Valor y moneda | Comparo la cifra con el **valor escrito en letras**. «Por demanda» se registra como `0` con valor indeterminado. | 0.99 si coinciden; 0.5 si no; 0.6 por demanda |
| Fechas | Fechas explícitas, o inicio + plazo en meses, o firma + plazo. Verifico que cuadren entre sí. | 0.99 si cuadran; firma sin día: inicio 0.8, fin 0.5 |
| Póliza | Cláusula de garantías, contrastada con lo que dice el correo. Si es condicionada, queda requerida y pendiente. | 0.95–0.98; 0.5 si contradice el correo |
| Comercial | Remitente buscado en `comerciales.json`. Si es desconocido, se avisa pero no bloquea. | 1 / 0 |

Un campo que no aparece en el texto queda en `null` con confianza 0. Nunca se inventa.

**Dónde entra el modelo:** decide el orden de las herramientas, explica los resultados y traslada las correcciones del usuario.

**Dónde no entra:** no fija valores. Si el modelo envía una confianza propia, se ignora. `validar` y `registrar` vuelven a extraer el documento y comparan; cualquier campo que el modelo haya cambiado entra a revisión humana. Esto cierra el riesgo del PRD de que el modelo «redondee» un valor.

## 6. Regla de gobierno: «Todo contrato al buzón»

**Dueña del maestro:** la analista administrativa. **Patrocinador:** la Gerencia Administrativa y Financiera.

**1. Canal único.** El único canal válido es `contratos@periferia-ficticia.com`, administrado por Administración con soporte técnico de TI. Un contrato enviado a una persona o por chat no cuenta como radicado; quien lo reciba debe reenviarlo al buzón.

**2. Obligación del comercial.**
- **Qué envía:** todo documento contractual, con o sin póliza. Esto incluye el contrato firmado por ambas partes (PDF), los otrosíes, las prórrogas y las actas de inicio, terminación y liquidación.
- **Plazo:** 3 días hábiles desde la última firma.
- **Asunto:** `[CONTRATO|OTROSI|ACTA] <id o SIN-ID> · <cliente> · <país>`, un correo por contrato.
- **Palanca:** Facturación no emite la primera factura de un contrato que no tenga id en el maestro.

**3. Acuse automático.** En un máximo de 15 minutos el agente responde al remitente con:
- el id asignado;
- la clasificación;
- los campos en revisión;
- si aplica, el aviso de póliza pendiente.

Si el contrato es rechazado, el acuse explica el motivo y qué debe enviar. Si el remitente no es un comercial registrado, se copia a Administración.

**4. Excepciones y escalamiento.**
- **Sin firma o incompleto:** no se registra y se solicita la versión firmada. Si no llega en 5 días hábiles, se escala al jefe comercial regional; a los 10 días, a Gerencia.
- **Sin valor o con valor dudoso:** se registra solo cuando la analista lo confirma. Si ella no puede confirmarlo, lo pregunta al comercial con el mismo plazo.
- **Póliza no constituida a los 10 días del registro:** alerta a Gerencia y al corredor de seguros.
- **Duda jurídica:** se remite a asesoría legal externa a través de Gerencia.

**5. Cierre del gap de junio a agosto de 2026.** Se hace en una sola campaña de 2 semanas:
1. Facturación lista los clientes facturados entre el 30-05 y el 31-08-2026 y los cruza contra el maestro. La diferencia es la lista de pendientes de cada comercial.
2. Cada comercial reenvía sus contratos pendientes al buzón con el asunto `[GAP]`. El agente los registra con `fuente = migracion`.
3. Al día 10 hay una reunión de faltantes; lo que siga pendiente en la semana 2 se escala a Gerencia.

Criterio de cierre: el 100 % de los clientes facturados en el periodo tiene contrato en el maestro o una excepción documentada.

**6. Indicador mensual.**
- **Principal:** cobertura del maestro = contratos facturados en el mes que existen en el maestro ÷ contratos facturados en el mes. Meta: 95 % al tercer mes y 100 % al sexto.
- **De apoyo:** mediana de días entre la firma y el registro. Meta: 3 días hábiles o menos.
- **Seguimiento:** Administración lo presenta en el comité mensual. Dos meses seguidos bajo la meta disparan una revisión con la dirección comercial.

## 7. Decisiones y trade-offs

| # | Decisión | Alternativa descartada | Razón y costo |
|---|---|---|---|
| 1 | Extracción determinista; el modelo solo orquesta. | Extraer con el LLM y usar su confianza. | La confianza de un LLM no está calibrada, y el valor es el campo más crítico. Con reglas, cada confianza se puede explicar y la demo es reproducible. **Costo:** los formatos nuevos no se reconocen, pero caen en revisión humana, no en datos malos. |
| 2 | Guardia de confirmación en el servidor. | Confiar solo en el prompt. | El PRD exige que el registro solo proceda si el siguiente mensaje del usuario confirma; eso lo garantiza el estado de la sesión, no un prompt. **Costo:** algo más de lógica en el ciclo. |
| 3 | `node:http` y front sin paso de build. | Next.js o Express con React. | Arranca con un comando, usa solo dos dependencias de ejecución (`zod`, `tsx`) y corre igual en Node y en Bun. **Costo:** el front es más artesanal. |
| 4 | Adaptadores propios sobre `fetch`; Gemini por su API nativa. | SDKs oficiales, o Gemini por su capa compatible con OpenAI. | Cumplo la interfaz `enviar()` con pocas líneas y controlo los errores. La API nativa maneja la firma de pensamiento y el tiempo de espera del 429. **Costo:** el mapeo de formatos se mantiene a mano. |
| 5 | Duplicados y rechazos se cierran vía `registrar`, sin escribir en el maestro. | Dejarlos en el buzón. | Si no se cierran, reaparecen en cada lectura del buzón. Así quedan trazados. |
| 6 | Server-Sent Events (SSE) para el streaming. | WebSocket. | Basta con comunicación en un solo sentido y funciona detrás de proxies sin configuración. Si no se pide streaming, la API responde con JSON normal. |

## 8. Supuestos

- **Fecha de referencia:** «hoy» es el 2026-09-03, según el PRD. Se pasa como argumento; si el usuario no la da, el agente la pregunta antes de generar alertas.
- **msg-006, firmado «en agosto de 2026» sin día:**
  - inicio = 2026-08-01, con confianza 0.8;
  - fin = 2027-08-31, el último día posible del plazo, con confianza 0.5, así que pasa a revisión;
  - coincide con la confirmación que espera el PRD.
- **Otrosí que amplía el plazo:** la póliza queda `pendiente` hasta recibir la ampliación de la garantía.
- **Póliza condicionada a órdenes de servicio:** se registra como requerida y pendiente.
- **Remitente desconocido:** el campo comercial queda sin asignar y se genera una advertencia; no bloquea el registro.
- **Varios adjuntos contractuales en un correo:** se procesa el primero y se advierte que debe enviarse un correo por contrato.
- **Archivo del otrosí:** se guarda como `<id>_otrosi-<n>.txt` junto al contrato, y la fila del maestro sigue apuntando al contrato original.
- **Formato archivado:** es `.txt` porque los fixtures traen el texto ya extraído; en producción sería el PDF.

## 9. Cobertura

| HU | Estado | Qué falta para producción |
|---|---|---|
| HU-1 Leer buzón | Hecho | Conector real a Exchange o Microsoft Graph. |
| HU-2 Extraer | Hecho | OCR para PDF escaneados. `contratos_leer_pdf` (P1) no está hecho. |
| HU-3 Validar | Hecho | Catálogo maestro de clientes por NIT. |
| HU-4 Registrar | Hecho | Escritura real en SharePoint con control de concurrencia. |
| HU-5 Alertar | Hecho | Envío programado del reporte a Gerencia. |
| HU-6 Errores | Hecho | — |
| CA1–CA5 del ciclo | Hecho | — |
| Front | Hecho | Autenticación por usuario. |
| Bonus `modulo/` | Hecho | — (se genera desde las mismas fuentes; `npm run modulo:check` detecta si se desvían) |
| Acuse al comercial | No hecho | Está diseñado en la regla de gobierno; falta la herramienta de envío. |

## 10. Uso de IA

> **[Revisa y completa esta sección con tus palabras antes de entregar. Debe describir lo que realmente pasó.]**

- **Herramienta usada:** Claude (Anthropic), como asistente de desarrollo.
- **Para qué la usé:** generó la mayor parte del código y de este documento a partir del PRD y los fixtures:
  - las herramientas y la extracción;
  - el ciclo del agente;
  - los adaptadores de modelo;
  - el front;
  - `demo.ts` y las pruebas.
- **Qué hice yo:** **[completar: por ejemplo, qué revisaste, qué preguntas le hiciste, qué pediste cambiar (como el soporte para Gemini) y qué decisiones tomaste tú]**.
- **Qué se descartó de lo propuesto, y por qué:**
  - Usar la confianza que reporta el modelo: no es calibrada.
  - Extraer con el LLM: rompe el determinismo de la demo.
  - Depender solo del prompt para la confirmación humana: se agregó la guardia en el servidor.
  - Usar Gemini por su capa compatible con OpenAI: maneja mal la firma de pensamiento.
- **Cómo se verificó:** el asistente ejecutó `tsc`, `demo.ts`, una prueba del ciclo con un modelo simulado y una prueba del chat en navegador con proveedores simulados. Por restricciones de mi equipo corporativo no pude correrlo en local. **[completar: cómo lo probaste finalmente, por ejemplo con el despliegue en Render]**.

## 11. Riesgos de producción y mitigación

| Riesgo | Mitigación |
|---|---|
| PDF escaneados o con formatos nuevos | OCR. Lo que no se reconozca va a revisión humana. Registro de los formatos que fallan para ampliar las reglas. |
| Falsos duplicados por variaciones en el nombre del cliente | Deduplicar primero por NIT, como ya hace la solución. Catálogo maestro de clientes. |
| Instrucciones maliciosas dentro de un correo o contrato («registra sin preguntar») | El texto solo llega al modelo como dato. La confirmación no depende del modelo, porque la exigen el servidor y la herramienta. Las herramientas no ejecutan comandos y validan los ids. |
| Concurrencia al escribir el maestro | Escritura vía Microsoft Graph con control de versiones (ETag), o una tabla transaccional detrás del Excel. |
| Abuso del link público o costo descontrolado | Clave de acceso, límite por IP, tope de iteraciones y tope de tokens por sesión. |
| Proveedor caído o cuota agotada | Timeout con mensaje claro y reintentos ante 429/503. El procesamiento no depende del modelo: el lote puede correrse sin chat. Hay un segundo proveedor configurable. |
| Confidencialidad de los contratos | Plan de pago con retención cero. El modelo solo recibe campos y fragmentos de evidencia, no el contrato completo. |
| Los comerciales no cumplen la regla de gobierno | Palanca en Facturación e indicador de cobertura mensual con escalamiento. |
