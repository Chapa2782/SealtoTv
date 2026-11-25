// ==========================================
// Sealto TV - Reproductor y Auto-Skip inicial
// ==========================================

const API_BASE = window.location.origin.includes(":5500")
  ? "http://127.0.0.1:8000"
  : "";

let canalesActivos = [];
let indiceActual = 0;
let hlsInstance = null;
let timerAutoSkip = null;
let usuarioInteractuoConAudio = false;

const MAX_AUTO_SKIP = 10;     // Máximo de canales a probar en cadena si fallan
const TIMEOUT_CARGA_MS = 6000; // Tiempo máximo antes de saltar al siguiente canal

// Elementos del DOM (ajustá los IDs si en tu index.html tienen otro nombre)
function getVideoElement() {
  return document.getElementById("video-player") || document.querySelector("video");
}

function getListaCanalesElement() {
  return document.getElementById("lista-canales");
}

function getEstadoElement() {
  return document.getElementById("estado-reproductor");
}

function setEstado(mensaje) {
  const el = getEstadoElement();
  if (el) {
    el.textContent = mensaje || "";
  }
}

// Marca visualmente el canal activo en la lista lateral
function marcarCanalActivoEnUI(canalId) {
  const items = document.querySelectorAll("[data-canal-id]");
  items.forEach((item) => {
    const esActivo = String(item.dataset.canalId) === String(canalId);
    item.classList.toggle("active", esActivo);
    item.classList.toggle("activo", esActivo);
    if (esActivo) {
      item.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  });
}

// Renderiza los canales en el contenedor lateral
function renderizarListaCanales(canales) {
  const contenedor = getListaCanalesElement();
  if (!contenedor) return;

  contenedor.innerHTML = "";

  if (!canales.length) {
    contenedor.innerHTML = `<div class="canal-vacio">No hay canales disponibles.</div>`;
    return;
  }

  canales.forEach((canal, idx) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "canal-item";
    item.dataset.canalId = canal.id ?? idx;

    const nombre = canal.nombre || canal.name || `Canal ${idx + 1}`;
    const categoria = canal.categoria || canal.group_title || "";

    item.innerHTML = `
      <span class="canal-numero">${idx + 1}</span>
      <span class="canal-info">
        <span class="canal-nombre">${nombre}</span>
        ${categoria ? `<span class="canal-categoria">${categoria}</span>` : ""}
      </span>
    `;

    item.addEventListener("click", () => {
      usuarioInteractuoConAudio = true;
      reproducirDesdeIndice(idx, 0);
    });

    contenedor.appendChild(item);
  });
}

// Limpia reproductor anterior y temporizadores
function limpiarReproductor() {
  clearTimeout(timerAutoSkip);
  timerAutoSkip = null;

  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }

  const video = getVideoElement();
  if (video) {
    video.onplaying = null;
    video.onerror = null;
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
}

// Intenta reproducir el video respetando políticas de autoplay del navegador
async function iniciarReproduccionSegura(video) {
  try {
    if (usuarioInteractuoConAudio) {
      video.muted = false;
    }
    await video.play();
  } catch (err) {
    if (err && err.name === "NotAllowedError") {
      // El navegador bloqueó el autoplay con audio: arrancamos muteados para mostrar imagen
      video.muted = true;
      setEstado("Reproduciendo sin audio (clic o tecla de volumen para activar sonido)");
      try {
        await video.play();
      } catch (_) {
        // Si falla incluso muteado, los eventos de error / timeout se encargan
      }
    }
  }
}

// Reproduce un canal por índice y salta al siguiente si falla
function reproducirDesdeIndice(indice, intentos = 0) {
  const video = getVideoElement();
  if (!video) return;

  if (!canalesActivos.length) {
    setEstado("Sin canales cargados");
    return;
  }

  if (intentos >= MAX_AUTO_SKIP || indice >= canalesActivos.length) {
    limpiarReproductor();
    setEstado("No se pudo iniciar ningún canal automáticamente. Elegí uno de la lista.");
    return;
  }

  indiceActual = indice;
  const canal = canalesActivos[indiceActual];
  const url = canal.url || canal.stream_url || canal.link;
  const nombre = canal.nombre || canal.name || `Canal ${indiceActual + 1}`;

  if (!url) {
    reproducirDesdeIndice(indiceActual + 1, intentos + 1);
    return;
  }

  limpiarReproductor();
  marcarCanalActivoEnUI(canal.id ?? indiceActual);
  setEstado(`Cargando ${nombre}...`);

  let yaSalto = false;
  const saltarAlSiguiente = (motivo) => {
    if (yaSalto) return;
    yaSalto = true;
    clearTimeout(timerAutoSkip);
    console.warn(`[Sealto TV] Falló "${nombre}" (${motivo}). Pasando al siguiente...`);
    reproducirDesdeIndice(indiceActual + 1, intentos + 1);
  };

  // Si tarda más de TIMEOUT_CARGA_MS sin tener datos listos para reproducir, salta
  timerAutoSkip = setTimeout(() => {
    if (video.readyState < 3) {
      saltarAlSiguiente("timeout");
    }
  }, TIMEOUT_CARGA_MS);

  video.onplaying = () => {
    clearTimeout(timerAutoSkip);
    if (!video.muted) {
      setEstado(`En vivo: ${nombre}`);
    }
  };

  video.onerror = () => {
    saltarAlSiguiente("video error");
  };

  const esHls = url.toLowerCase().includes(".m3u8");

  if (esHls && window.Hls && window.Hls.isSupported()) {
    hlsInstance = new window.Hls({
      enableWorker: true,
      manifestLoadingTimeOut: 5000,
      levelLoadingTimeOut: 5000,
      fragLoadingTimeOut: 6000
    });

    hlsInstance.loadSource(url);
    hlsInstance.attachMedia(video);

    hlsInstance.on(window.Hls.Events.MANIFEST_PARSED, () => {
      iniciarReproduccionSegura(video);
    });

    hlsInstance.on(window.Hls.Events.ERROR, (_event, data) => {
      if (data && data.fatal) {
        saltarAlSiguiente(`hls fatal: ${data.type}`);
      }
    });
  } else {
    video.src = url;
    iniciarReproduccionSegura(video);
  }
}

// Carga los canales desde FastAPI y arranca automáticamente en el primero
async function cargarCanalesEIniciar(filtros = {}) {
  try {
    setEstado("Cargando canales...");
    const params = new URLSearchParams();
    if (filtros.categoria) params.set("categoria", filtros.categoria);
    if (filtros.idioma) params.set("idioma", filtros.idioma);
    if (filtros.buscar) params.set("q", filtros.buscar);

    const queryStr = params.toString() ? `?${params.toString()}` : "";
    const resp = await fetch(`${API_BASE}/api/canales${queryStr}`);

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }

    const data = await resp.json();
    canalesActivos = Array.isArray(data) ? data : (data.canales || []);

    renderizarListaCanales(canalesActivos);

    if (canalesActivos.length > 0) {
      reproducirDesdeIndice(0, 0);
    } else {
      setEstado("No se encontraron canales con ese filtro.");
    }
  } catch (err) {
    console.error("[Sealto TV] Error al obtener /api/canales:", err);
    setEstado("Error al conectar con el servidor de canales.");
  }
}

// Marca interacción del usuario para permitir audio en futuros cambios de canal
["click", "keydown"].forEach((evento) => {
  window.addEventListener(evento, () => {
    usuarioInteractuoConAudio = true;
    const video = getVideoElement();
    if (video && video.muted && evento === "keydown") {
      // Si el usuario presiona una tecla de volumen o M, podés desmutear acá según tu mapa de teclas
    }
  }, { passive: true });
});

// Inicio al cargar la página
document.addEventListener("DOMContentLoaded", () => {
  cargarCanalesEIniciar();
});