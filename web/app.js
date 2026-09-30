// Front del chat: historial, llamadas a herramientas visibles, estado "pensando" y confirmación resaltada.
// Sin dependencias. Consume POST /api/chat?stream=1 (Server-Sent Events).
(() => {
  const $ = (sel) => document.querySelector(sel)
  const historial = $("#historial")
  const vacio = $("#vacio")
  const form = $("#form")
  const entrada = $("#mensaje")
  const btnEnviar = $("#btn-enviar")
  const estado = $("#estado")
  const panelCuerpo = $("#panel-cuerpo")

  const nuevoId = () => `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  let sessionId = localStorage.getItem("sessionId") || nuevoId()
  localStorage.setItem("sessionId", sessionId)
  let claveAcceso = localStorage.getItem("accessKey") || ""
  let ocupado = false
  let pestana = "maestro"
  const idsIniciales = new Set()

  // ------------------------------------------------------------ utilidades

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])

  function inline(texto) {
    return esc(texto)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,;:])/g, "$1<em>$2</em>")
  }

  // Markdown mínimo: encabezados, listas, tablas, bloques de código, negritas y código en línea.
  function markdown(md) {
    const lineas = String(md).replace(/\r/g, "").split("\n")
    const out = []
    let i = 0
    const esFilaTabla = (l) => /^\s*\|.*\|\s*$/.test(l)
    const celdas = (l) => l.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"))
    while (i < lineas.length) {
      const l = lineas[i]
      if (/^```/.test(l)) {
        const bloque = []
        i++
        while (i < lineas.length && !/^```/.test(lineas[i])) bloque.push(lineas[i++])
        i++
        out.push(`<pre><code>${esc(bloque.join("\n"))}</code></pre>`)
      } else if (esFilaTabla(l) && i + 1 < lineas.length && /^\s*\|?\s*:?-{2,}/.test(lineas[i + 1])) {
        const cab = celdas(l)
        i += 2
        const filas = []
        while (i < lineas.length && esFilaTabla(lineas[i])) filas.push(celdas(lineas[i++]))
        out.push(
          `<div class="tabla-wrap"><table><thead><tr>${cab.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${filas
            .map((f) => `<tr>${f.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
            .join("")}</tbody></table></div>`,
        )
      } else if (/^#{1,4}\s/.test(l)) {
        const nivel = Math.min(3, l.match(/^#+/)[0].length)
        out.push(`<h${nivel}>${inline(l.replace(/^#+\s*/, ""))}</h${nivel}>`)
        i++
      } else if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
        const ordenada = /^\s*\d+\./.test(l)
        const items = []
        while (i < lineas.length && /^\s*([-*]|\d+\.)\s+/.test(lineas[i])) items.push(lineas[i++].replace(/^\s*([-*]|\d+\.)\s+/, ""))
        const tag = ordenada ? "ol" : "ul"
        out.push(`<${tag}>${items.map((it) => `<li>${inline(it)}</li>`).join("")}</${tag}>`)
      } else if (l.trim() === "" || /^-{3,}$/.test(l.trim())) {
        i++
      } else {
        const parrafo = []
        while (i < lineas.length && lineas[i].trim() !== "" && !/^(```|#{1,4}\s|\s*([-*]|\d+\.)\s+)/.test(lineas[i]) && !esFilaTabla(lineas[i])) parrafo.push(lineas[i++])
        out.push(`<p>${parrafo.map(inline).join("<br>")}</p>`)
      }
    }
    return out.join("")
  }

  async function api(ruta, opciones = {}) {
    const headers = { "content-type": "application/json", ...(claveAcceso ? { "x-access-key": claveAcceso } : {}), ...(opciones.headers || {}) }
    const res = await fetch(ruta, { ...opciones, headers })
    if (res.status === 401) {
      pedirClave()
      throw new Error("Se requiere la clave de acceso.")
    }
    return res
  }

  function pedirClave() {
    const dlg = $("#dlg-clave")
    if (!dlg.open) dlg.showModal()
  }
  $("#form-clave").addEventListener("submit", () => {
    claveAcceso = $("#input-clave").value.trim()
    localStorage.setItem("accessKey", claveAcceso)
    cargarPanel()
    cargarSesion()
  })

  const alFinal = () => historial.scrollTo({ top: historial.scrollHeight, behavior: "smooth" })

  // ------------------------------------------------------------ render de eventos

  function renderUsuario(texto) {
    const div = document.createElement("div")
    div.className = "msg msg-usuario"
    div.textContent = texto
    historial.appendChild(div)
  }

  function argsCortos(nombre, args) {
    if (!args || typeof args !== "object") return ""
    const partes = []
    if (args.mensaje_id) partes.push(args.mensaje_id)
    if (args.confirmado) partes.push("confirmado=true")
    if (args.hoy) partes.push(`hoy=${args.hoy}`)
    if (args.id_contrato) partes.push(args.id_contrato)
    return partes.join(" · ")
  }

  function bonito(texto) {
    try {
      return JSON.stringify(typeof texto === "string" ? JSON.parse(texto) : texto, null, 2)
    } catch {
      return String(texto)
    }
  }

  function renderHerramienta(e) {
    const d = document.createElement("details")
    d.className = `msg herr${e.ok ? "" : " error"}${e.bloqueada ? " bloqueada" : ""}`
    d.innerHTML = `<summary><span class="marca-ok" aria-label="${e.ok ? "correcto" : "error"}">${e.ok ? "✓" : "✕"}</span><span class="nombre">${esc(e.nombre)}</span><span class="arg">${esc(argsCortos(e.nombre, e.args))}</span><span class="res">${esc(e.resumen)}</span></summary>
      <div class="herr-cuerpo"><h4>Argumentos</h4><pre>${esc(bonito(e.args))}</pre><h4>Resultado</h4><pre>${esc(bonito(e.resultado))}</pre></div>`
    historial.appendChild(d)
  }

  function renderAsistente(e) {
    const div = document.createElement("div")
    div.className = `msg msg-asistente${e.final ? "" : " intermedio"}${e.needsConfirmation ? " confirmar" : ""}`
    div.innerHTML = `${e.needsConfirmation ? '<span class="sello">Requiere tu confirmación</span>' : ""}<div class="md">${markdown(e.texto)}</div>`
    if (e.needsConfirmation) {
      const acciones = document.createElement("div")
      acciones.className = "confirmar-acciones"
      acciones.innerHTML = `<button type="button" class="btn-sello">Confirmar lo propuesto</button><button type="button" class="btn-sello-sec">Corregir un valor</button>`
      acciones.querySelector(".btn-sello").addEventListener("click", () => enviar("Confirmo los valores propuestos para los campos en revisión. Regístralo."))
      acciones.querySelector(".btn-sello-sec").addEventListener("click", () => {
        entrada.value = "Corrijo: "
        entrada.focus()
      })
      div.appendChild(acciones)
    }
    historial.appendChild(div)
  }

  function renderError(texto) {
    const div = document.createElement("div")
    div.className = "msg msg-error"
    div.setAttribute("role", "alert")
    div.textContent = texto
    historial.appendChild(div)
  }

  function renderEvento(e) {
    vacio.hidden = true
    if (e.tipo === "usuario") renderUsuario(e.texto)
    else if (e.tipo === "herramienta") renderHerramienta(e)
    else if (e.tipo === "asistente") renderAsistente(e)
    else if (e.tipo === "error") renderError(e.texto)
  }

  // Los botones de confirmación de turnos anteriores dejan de estar activos.
  function desactivarConfirmacionesPrevias() {
    historial.querySelectorAll(".confirmar-acciones").forEach((n) => n.remove())
  }

  let indicador = null
  function mostrarPensando(texto) {
    if (!indicador) {
      indicador = document.createElement("div")
      indicador.className = "msg pensando"
    }
    indicador.textContent = texto
    historial.appendChild(indicador)
    alFinal()
  }
  function ocultarPensando() {
    indicador?.remove()
  }

  // ------------------------------------------------------------ envío (SSE)

  async function enviar(texto) {
    texto = texto.trim()
    if (!texto || ocupado) return
    ocupado = true
    btnEnviar.disabled = true
    entrada.value = ""
    desactivarConfirmacionesPrevias()
    mostrarPensando("Pensando…")
    let recibioFin = false
    try {
      const res = await api("/api/chat?stream=1", { method: "POST", body: JSON.stringify({ sessionId, message: texto }) })
      if (!res.ok || !res.body) {
        const cuerpo = await res.json().catch(() => ({}))
        renderUsuario(texto)
        renderError(cuerpo.error || `El servidor respondió ${res.status}.`)
        return
      }
      const lector = res.body.getReader()
      const dec = new TextDecoder()
      let buffer = ""
      for (;;) {
        const { value, done } = await lector.read()
        if (done) break
        buffer += dec.decode(value, { stream: true })
        let corte
        while ((corte = buffer.indexOf("\n\n")) >= 0) {
          const bloque = buffer.slice(0, corte)
          buffer = buffer.slice(corte + 2)
          const evento = /^event: (.+)$/m.exec(bloque)?.[1]
          const datos = /^data: (.+)$/m.exec(bloque)?.[1]
          if (!evento || !datos) continue
          const e = JSON.parse(datos)
          if (evento === "pensando") mostrarPensando(e.iteracion > 1 ? `Pensando… (iteración ${e.iteracion})` : "Pensando…")
          else if (evento === "fin") {
            recibioFin = true
            actualizarTokens(e.tokensSesion)
          } else {
            ocultarPensando()
            renderEvento(e)
            if (evento === "herramienta") mostrarPensando("Procesando resultado…")
            alFinal()
          }
        }
      }
      if (!recibioFin) renderError("La conexión se cortó antes de terminar. Lo ya registrado quedó guardado; recargue para ver el historial.")
    } catch (err) {
      renderError(err.message || "No se pudo contactar al servidor.")
    } finally {
      ocultarPensando()
      ocupado = false
      btnEnviar.disabled = false
      alFinal()
      cargarPanel()
    }
  }

  function actualizarTokens(t) {
    if (!t) return
    estado.dataset.tokens = `${(t.entrada + t.salida).toLocaleString("es-CO")} tokens en la sesión`
    estado.textContent = `${estado.dataset.base} · ${estado.dataset.tokens}`
  }

  form.addEventListener("submit", (ev) => {
    ev.preventDefault()
    enviar(entrada.value)
  })
  entrada.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault()
      enviar(entrada.value)
    }
  })
  document.querySelectorAll(".sugerencia").forEach((b) => b.addEventListener("click", () => enviar(b.dataset.prompt)))

  $("#btn-nueva").addEventListener("click", () => {
    sessionId = nuevoId()
    localStorage.setItem("sessionId", sessionId)
    historial.querySelectorAll(".msg").forEach((n) => n.remove())
    vacio.hidden = false
  })
  $("#btn-reset").addEventListener("click", async () => {
    if (!confirm("Esto borra el maestro de trabajo, el historial y los procesados en out/ para repetir la demo. ¿Continuar?")) return
    await api("/api/reset", { method: "POST" })
    $("#btn-nueva").click()
    cargarPanel()
  })
  $("#btn-panel").addEventListener("click", () => {
    const abierto = $("#panel").classList.toggle("abierto")
    $("#btn-panel").setAttribute("aria-expanded", String(abierto))
  })

  // ------------------------------------------------------------ panel: maestro y alertas

  document.querySelectorAll(".pestanas button").forEach((b) =>
    b.addEventListener("click", () => {
      pestana = b.dataset.tab
      document.querySelectorAll(".pestanas button").forEach((x) => x.setAttribute("aria-selected", String(x === b)))
      cargarPanel()
    }),
  )

  const fmtValor = (v, m) => (Number(v) === 0 ? "por demanda" : `${m} ${Number(v).toLocaleString("es-CO")}`)

  async function cargarPanel() {
    try {
      if (pestana === "maestro") {
        const r = await (await api("/api/maestro")).json()
        if (!r.ok) throw new Error(r.error)
        if (idsIniciales.size === 0) r.filas.filter((f) => f.fuente !== "buzon" || f.fecha_registro < "2026-05-31").forEach((f) => idsIniciales.add(f.id_contrato))
        panelCuerpo.innerHTML =
          `<p class="panel-nota">${r.filas.length} contratos en el maestro de trabajo. Resaltados: registrados desde el corte.</p>` +
          [...r.filas]
            .reverse()
            .map(
              (f) => `<div class="fila-contrato${f.fecha_registro > "2026-05-30" ? " nueva" : ""}">
              <div class="fc-top"><span class="fc-id">${esc(f.id_contrato)}</span><span class="etq ${esc(f.estado_poliza)}">${esc(f.estado_poliza === "no_aplica" ? "sin póliza" : `póliza ${f.estado_poliza}`)}</span></div>
              <div class="fc-cliente">${esc(f.cliente)}</div>
              <div class="fc-meta">${esc(fmtValor(f.valor, f.moneda))} · ${esc(f.fecha_inicio)} a ${esc(f.fecha_fin)}${f.comercial ? ` · ${esc(f.comercial)}` : " · comercial sin asignar"}</div>
            </div>`,
            )
            .join("")
      } else {
        const r = await (await api("/api/alertas")).json()
        panelCuerpo.innerHTML = r.markdown
          ? `<div class="md">${markdown(r.markdown)}</div>`
          : `<p class="panel-nota">Aún no hay reporte. Pide al agente «genera las alertas con fecha de hoy 2026-09-03».</p>`
      }
    } catch (err) {
      panelCuerpo.innerHTML = `<p class="panel-nota">${esc(err.message)}</p>`
    }
  }

  // ------------------------------------------------------------ arranque

  async function cargarSalud() {
    try {
      const h = await (await fetch("/api/health")).json()
      estado.dataset.base = `${h.provider} · ${h.model}`
      estado.textContent = h.llmConfigurado ? estado.dataset.base : `${estado.dataset.base} · sin clave de API`
      estado.className = `estado ${h.llmConfigurado ? "ok" : "mal"}`
      if (h.requiereClaveAcceso && !claveAcceso) pedirClave()
    } catch {
      estado.textContent = "Servidor no disponible"
      estado.className = "estado mal"
    }
  }

  async function cargarSesion() {
    try {
      const res = await api(`/api/sessions/${sessionId}`)
      if (!res.ok) return
      const s = await res.json()
      historial.querySelectorAll(".msg").forEach((n) => n.remove())
      const ultimoFinal = [...s.vista].reverse().find((e) => e.tipo === "asistente" && e.final)
      s.vista.forEach((e) => renderEvento(e.tipo === "asistente" && e !== ultimoFinal ? { ...e, needsConfirmation: false } : e))
      actualizarTokens(s.tokens)
      alFinal()
    } catch {
      /* sesión nueva */
    }
  }

  cargarSalud().then(() => {
    cargarSesion()
    cargarPanel()
  })
})()
