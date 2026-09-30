---
name: registro-contratos
description: Conocimiento del proceso de registro de contratos vigentes de Periferia IT Group — maestro de SharePoint, reglas de negocio RN1–RN7, clasificación de correos, pólizas, otrosíes y alertas de vencimiento. Úsala al procesar el buzón de contratos.
---

<!-- GENERADO por scripts/modulo.ts desde src/knowledge/registro-contratos.md. No editar a mano. -->

# Proceso de registro de contratos vigentes

## Contexto

El maestro de contratos (Excel en SharePoint, simulado como `out/sharepoint/maestro-contratos.csv`) estuvo congelado desde el **2026-05-30**. Antes solo llegaban los contratos con póliza. Ahora **todo** contrato firmado, otrosí o acta de terminación debe llegar al buzón único `contratos@periferia-ficticia.com` y quedar en el maestro, tenga o no póliza.

## Esquema del maestro (una fila por contrato)

| Columna | Regla |
|---|---|
| `id_contrato` | Número tal como aparece en el documento. Si no tiene, `AUTO-<año>-<secuencia>`. |
| `cliente` | Razón social de la contraparte (nunca Periferia IT Group). |
| `nit_cliente` | Identificador tributario sin dígito de verificación ni puntos. |
| `pais` | `CO`, `EC`, `PE`, `PA` o `HN`, inferido del identificador y del domicilio. |
| `objeto` | Máximo 200 caracteres. |
| `valor` | Número sin separadores. `0` si el contrato es por demanda (`valor_indeterminado = true`). |
| `moneda` | `COP`, `USD`, `PEN`, `PAB` o `HNL`. |
| `fecha_inicio` / `fecha_fin` | `YYYY-MM-DD`. `fecha_fin` puede derivarse del plazo en meses (inicio + N meses − 1 día). |
| `requiere_poliza` / `tipo_poliza` | Tipos separados por `;` (cumplimiento, calidad, responsabilidad_civil, salarios_prestaciones…). |
| `estado_poliza` | `vigente`, `pendiente`, `vencida` o `no_aplica`. Todo registro nuevo con póliza entra `pendiente`. |
| `comercial` | Nombre resuelto desde `comerciales.json` por el correo del remitente. |
| `ruta_sharepoint` | `Contratos/<año_inicio>/<cliente-slug>/<id_contrato>.<ext>`. |
| `fecha_registro`, `fuente` | Fecha de la operación; `buzon` para lo que entra por el agente. |

## Reglas de negocio

- **RN1 · Duplicado**: mismo `id_contrato` y mismos `valor`, `fecha_inicio` y `fecha_fin`. No se escribe nada; se reporta.
- **RN2 · Actualización**: mismo `id_contrato` (o mismo `nit_cliente` + `objeto` con similitud ≥ 0.9) y algún campo distinto, o el documento es un otrosí. Se actualiza la fila y el cambio queda en `historial.jsonl`. Un otrosí que amplía plazo deja la póliza en `pendiente` hasta recibir la ampliación de la garantía.
- **RN3 · Nuevo**: sin coincidencia. Se inserta.
- **RN4 · Rechazado**: sin adjunto de contrato (cotización, propuesta, pregunta) o texto sin partes ni objeto identificables. Se reporta con motivo.
- **RN5 · Revisión humana**: todo campo con confianza < 0.8 detiene el registro hasta que la analista confirme. También cualquier valor que difiera de lo extraído del documento.
- **RN6**: el fixture del maestro es de solo lectura; se trabaja sobre la copia en `out/sharepoint/`.
- **RN7**: toda ejecución de herramienta deja traza en `out/log.jsonl`.

## Cómo interpretar la confianza

- ≥ 0.95: el dato aparece literal y se verificó con una segunda fuente (p. ej. valor en letras = valor en números, plazo en meses = fechas desde/hasta).
- 0.8–0.94: el dato aparece literal pero sin verificación cruzada, o se derivó con una regla segura.
- < 0.8: el dato se infirió (firma sin día, valor por demanda, moneda por país) o hay contradicción. Siempre se pregunta.
- `comercial` con confianza 0 significa remitente no registrado: se informa, pero **no** bloquea.

## Alertas

- Vencen en ≤ 60 días desde la fecha de referencia.
- Pólizas: `requiere_poliza = true` y `estado_poliza` distinto de `vigente`.
- Gap cubierto: todo lo insertado o actualizado desde el corte del 2026-05-30.
- Informativo: contratos ya vencidos sin renovación registrada.

## Glosario

- **Otrosí**: documento que modifica un contrato existente (plazo, valor, cláusulas). Nunca crea un contrato nuevo.
- **Contrato marco**: fija condiciones generales; el valor se define por órdenes de servicio. Se registra con valor 0 e indeterminado.
- **Póliza de cumplimiento**: garantía que el contratista constituye a favor del cliente; su constitución es responsabilidad de administración con el corredor.
