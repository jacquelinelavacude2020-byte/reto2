/**
 * Parámetros de negocio. Cambiar una regla (umbral, días de alerta, fecha de corte)
 * se hace aquí, sin tocar el servidor ni el ciclo del agente.
 */
export const REGLAS = {
  /** RN5: campos con confianza estrictamente menor pasan a revisión humana. */
  umbralConfianza: 0.8,
  /** RN2: similitud mínima de objeto (mismo NIT) para considerar que es el mismo contrato. */
  umbralSimilitudObjeto: 0.9,
  /** HU-5: ventana de alerta de vencimiento. */
  diasAlertaVencimiento: 60,
  /** Fecha de congelamiento del maestro. */
  fechaCorteMaestro: "2026-05-30",
  /** Máximo de caracteres del objeto (esquema 7.2). */
  maxCaracteresObjeto: 200,
  /** NIT de la propia empresa: nunca es el cliente. */
  nitPropio: "900123456",
} as const

export const RUTAS = {
  fixtures: "fixtures/reto-02",
  buzon: "fixtures/reto-02/buzon",
  maestroFixture: "fixtures/reto-02/maestro-contratos.csv",
  comerciales: "fixtures/reto-02/comerciales.json",
  out: "out",
  sharepoint: "out/sharepoint",
  maestro: "out/sharepoint/maestro-contratos.csv",
  historial: "out/sharepoint/historial.jsonl",
  procesados: "out/procesados.json",
  log: "out/log.jsonl",
  alertas: "out/alertas.md",
} as const

export const PAISES = ["CO", "EC", "PE", "PA", "HN"] as const
export const MONEDAS = ["COP", "USD", "PEN", "PAB", "HNL"] as const
export const ESTADOS_POLIZA = ["vigente", "pendiente", "vencida", "no_aplica"] as const
export const TIPOS_DOCUMENTO = ["contrato", "otrosi", "cotizacion", "desconocido"] as const
export const CLASIFICACIONES = ["nuevo", "actualizacion", "duplicado", "rechazado"] as const

export type Pais = (typeof PAISES)[number]
export type Moneda = (typeof MONEDAS)[number]
export type EstadoPoliza = (typeof ESTADOS_POLIZA)[number]
export type TipoDocumento = (typeof TIPOS_DOCUMENTO)[number]
export type Clasificacion = (typeof CLASIFICACIONES)[number]

/** Campos del maestro que llevan confianza de extracción. */
export const CAMPOS_CON_CONFIANZA = [
  "id_contrato",
  "cliente",
  "nit_cliente",
  "pais",
  "objeto",
  "valor",
  "moneda",
  "fecha_inicio",
  "fecha_fin",
  "requiere_poliza",
  "tipo_poliza",
  "comercial",
] as const
export type CampoConConfianza = (typeof CAMPOS_CON_CONFIANZA)[number]

/** Columnas del maestro, en orden (sección 7.2 del PRD). */
export const COLUMNAS_MAESTRO = [
  "id_contrato",
  "cliente",
  "nit_cliente",
  "pais",
  "objeto",
  "valor",
  "moneda",
  "fecha_inicio",
  "fecha_fin",
  "requiere_poliza",
  "tipo_poliza",
  "estado_poliza",
  "comercial",
  "ruta_sharepoint",
  "fecha_registro",
  "fuente",
] as const
export type ColumnaMaestro = (typeof COLUMNAS_MAESTRO)[number]
export type FilaMaestro = Record<ColumnaMaestro, string>
