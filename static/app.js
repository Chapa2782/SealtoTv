/* =====================================================================
   Sealto TV - front
   - Carga progresiva por scroll en la lista de canales (sin trabar el arranque)
   - Estado de cada canal (en línea / caído / sin verificar) visible en la lista
   - Reproductor con reintentos con espera creciente, recuperación de errores
     de HLS, detección de cortes (watchdog), cambio automático de fuente
     y modo de estabilidad manual con colchón regulable
   - Filtros desplegables de categoría e idioma (dinámico según canales cargados)
   - Navegación de canales con teclas Arriba / Abajo (incluso en pantalla completa)
   - Navegación de categorías con teclas Izquierda / Derecha (incluso en pantalla completa)
   - Shortcuts alfanuméricos:
       * Tecla 1: agregar / quitar canal actual de favoritos
       * Tecla 2: alternar recorrido de flechas entre lista de favoritos y lista principal
       * Tecla 3: habilitar / deshabilitar mute
       * Tecla 4: bajar volumen
       * Tecla 5: subir volumen
       * Tecla 7: activar / desactivar modo estabilidad (colchón de señal)
       * Tecla 8: reducir segundos del colchón de estabilidad
       * Tecla 9: aumentar segundos del colchón de estabilidad (máx. 100s)
   ===================================================================== */
const API_URL = '/api';

const ORDEN_ESTADO = { ok: 0, desconocido: 1, caido: 2 };
const ESTADO_TEXTO = { ok: 'En línea', caido: 'Caído', desconocido: 'Sin verificar' };
const STORAGE_FAVORITOS = 'xuper_tv_favoritos_v1';
const PASO_VOLUMEN = 0.1;

// Carga progresiva por scroll para no congelar el DOM con listas grandes
const LOTE_INICIAL_CANALES = 45;
const LOTE_SCROLL_CANALES = 35;
const MARGEN_SCROLL_PX = 240;

// Parámetros de estabilidad del reproductor
const BACKOFF_MS = [2000, 4000, 8000, 15000];
const MAX_REINTENTOS = BACKOFF_MS.length;
const TIMEOUT_ARRANQUE_MS = 20000;
const TIMEOUT_CORTE_MS = 15000;
const ESTABLE_TRAS_MS = 20000;
const MAX_RECUPERACIONES_MEDIA = 2;

// Parámetros del modo estabilidad (colchón regulable con teclas 8 y 9)
const COLCHON_DEFAULT_SEG = 14;
const COLCHON_MIN_SEG = 4;
const COLCHON_MAX_SEG = 100;
const COLCHON_PASO_SEG = 2;

let colchonObjetivoSeg = COLCHON_DEFAULT_SEG;

let todosLosCanales = [];
let canalesSeccion = [];
let canalesVisibles = [];
let indiceRenderizado = 0;
let cargandoLoteScroll = false;

let categoriasDisponibles = [];
let categoriaFiltro = 'TODO';
let idiomaFiltro = 'TODOS';
let textoBusqueda = '';
let ocultarCaidos = leerPref('ocultarCaidos') === '1';
let canalActivo = null;
let timeoutBusqueda = null;
let avisoFsDialog = null;
let avisoFsTimer = null;
let timerAviso = null;
let timerShortcutAviso = null;

// 'principal' | 'favoritos'
let modoRecorrido = 'principal';

const canalPorId = new Map();
const canalPorUrl = new Map();
const tarjetas = new Map();
let tarjetaActiva = null;

let favoritosMemoria = [];
let favoritos = leerFavoritos();
const filasFav = new Map();
let filaFavActiva = null;

const player = {
    sesion: 0,
    hls: null,
    modo: null,
    intento: 0,
    recuperacionesMedia: 0,
    forzarDirecto: false,
    esperandoRed: false,
    fuentesProbadas: new Set(),
    timerReintento: null,
    watchdog: null,
    timerEstable: null,
    timerSpinner: null,
    // Control manual de estabilidad / colchón
    modoColchon: false,
    esperandoColchon: false,
    timerColchon: null,
    timerColchonTope: null,
};

const el = {};

/* ---------- Utilidades ---------- */
function leerPref(clave) {
    try { return localStorage.getItem(clave); } catch (e) { return null; }
}
function guardarPref(clave, valor) {
    try {
        localStorage.setItem(clave, valor);
        return true;
    } catch (e) {
        return false;
    }
}
function normalizar(texto) {
    return (texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}
function claveCanal(nombre) {
    return normalizar(nombre)
        .replace(/\b(hd|fhd|uhd|sd|4k|1080p?|720p?|480p?)\b/g, '')
        .replace(/[^a-z0-9]/g, '');
}
function estadoDe(canal) {
    return ORDEN_ESTADO[canal && canal.estado] !== undefined ? canal.estado : 'desconocido';
}

/* ---------- Inicio ---------- */
document.addEventListener('DOMContentLoaded', () => {
    try {
        el.video = document.getElementById('video-player');
        el.overlay = document.getElementById('player-overlay');
        el.spinner = document.getElementById('player-spinner');
        el.msg = document.getElementById('player-msg');
        el.acciones = document.getElementById('player-actions');
        el.btnReintentar = document.getElementById('btn-reintentar');
        el.titulo = document.getElementById('current-channel-title');
        el.grilla = document.getElementById('channels-container');
        el.stats = document.getElementById('channels-stats');
        el.toggleCaidos = document.getElementById('toggle-caidos');
        el.btnCorazon = document.getElementById('btn-corazon');
        el.btnCorazonBarra = document.getElementById('btn-corazon-barra');
        el.favAviso = document.getElementById('fav-aviso');
        el.shortcutAviso = document.getElementById('shortcut-aviso');
        el.btnFavoritos = document.getElementById('btn-favoritos');
        el.favPanel = document.getElementById('favoritos-panel');
        el.favLista = document.getElementById('favoritos-lista');
        el.favCount = document.getElementById('fav-count');
        el.btnFiltroCat = document.getElementById('btn-filtro-cat');
        el.filtroCatValor = document.getElementById('filtro-cat-valor');
        el.filtroCatMenu = document.getElementById('filtro-cat-menu');
        el.btnFiltroLang = document.getElementById('btn-filtro-lang');
        el.filtroLangValor = document.getElementById('filtro-lang-valor');
        el.filtroLangMenu = document.getElementById('filtro-lang-menu');

        if (el.video) configurarEventosVideo();
        configurarScrollInfinitoCanales();
        configurarBotonCorazonBarra();
        configurarBotonesCategoria();
        configurarDesplegableCategorias();
        configurarDesplegableIdiomas();
        configurarTecladoCanales();
        renderizarFavoritos();
        actualizarBotonCorazon();
        cargarCanalesIniciales();

        const inputBusqueda = document.getElementById('search-input');
        if (inputBusqueda) {
            inputBusqueda.addEventListener('input', (e) => {
                clearTimeout(timeoutBusqueda);
                const valor = e.target.value;
                timeoutBusqueda = setTimeout(() => {
                    textoBusqueda = valor.trim();
                    aplicarFiltros();
                }, 250);
            });
        }

        if (el.toggleCaidos) {
            el.toggleCaidos.checked = ocultarCaidos;
            el.toggleCaidos.addEventListener('change', () => {
                ocultarCaidos = el.toggleCaidos.checked;
                guardarPref('ocultarCaidos', ocultarCaidos ? '1' : '0');
                aplicarFiltros();
            });
        }

        if (el.btnReintentar) {
            el.btnReintentar.addEventListener('click', () => {
                const canal = obtenerCanalActualEfectivo();
                if (canal) reproducirCanal(canal, { manual: true });
            });
        }

        if (el.btnFavoritos) {
            el.btnFavoritos.addEventListener('click', () => alternarPanelFavoritos());
        }

        window.addEventListener('storage', (e) => {
            if (e.key !== STORAGE_FAVORITOS) return;
            favoritos = leerFavoritos();
            renderizarFavoritos();
            actualizarBotonCorazon();
        });

        window.addEventListener('online', () => {
            if (canalActivo && player.esperandoRed) {
                player.esperandoRed = false;
                player.intento = 0;
                iniciarReproduccion();
            }
        });
    } catch (err) {
        console.error('Error al iniciar Sealto TV:', err);
    }
});

/* ---------- Carga progresiva por scroll ---------- */
function configurarScrollInfinitoCanales() {
    if (!el.grilla) return;
    el.grilla.addEventListener('scroll', () => {
        if (cargandoLoteScroll) return;
        if (indiceRenderizado >= canalesVisibles.length) return;
        const restante = el.grilla.scrollHeight - el.grilla.scrollTop - el.grilla.clientHeight;
        if (restante <= MARGEN_SCROLL_PX) {
            cargandoLoteScroll = true;
            requestAnimationFrame(() => {
                renderizarSiguienteLote(LOTE_SCROLL_CANALES);
                cargandoLoteScroll = false;
            });
        }
    }, { passive: true });
}

function asegurarTarjetaEnDOM(canalId) {
    if (tarjetas.has(canalId)) return tarjetas.get(canalId);
    const idx = canalesVisibles.findIndex(c => Number(c.id) === Number(canalId));
    if (idx === -1) return null;
    while (indiceRenderizado <= idx && indiceRenderizado < canalesVisibles.length) {
        renderizarSiguienteLote(LOTE_SCROLL_CANALES);
    }
    return tarjetas.get(canalId) || null;
}

/* ---------- Desplegable de categorías ---------- */
function cerrarMenuCategorias() {
    if (!el.filtroCatMenu || !el.btnFiltroCat) return;
    el.filtroCatMenu.hidden = true;
    el.btnFiltroCat.setAttribute('aria-expanded', 'false');
}

function alternarMenuCategorias(forzar) {
    if (!el.filtroCatMenu || !el.btnFiltroCat) return;
    const abrir = typeof forzar === 'boolean' ? forzar : el.filtroCatMenu.hidden;
    el.filtroCatMenu.hidden = !abrir;
    el.btnFiltroCat.setAttribute('aria-expanded', abrir ? 'true' : 'false');
}

function aplicarCategoriaSeleccionada(item, { mostrarAviso = false } = {}) {
    if (!item) return;
    categoriaFiltro = item.filtro;
    if (el.filtroCatValor) el.filtroCatValor.textContent = item.etiqueta;

    if (el.filtroCatMenu) {
        el.filtroCatMenu.querySelectorAll('.filtro-cat-opcion').forEach(b => {
            const esActiva = (b.getAttribute('data-filtro') || 'TODO') === item.filtro;
            b.classList.toggle('activa', esActiva);
            b.setAttribute('aria-selected', esActiva ? 'true' : 'false');
        });
    }

    aplicarFiltros();
    if (mostrarAviso) {
        mostrarAvisoTransitorio(`categoría: ${item.etiqueta}`);
    }
}

function navegarCategoriaConFlecha(direccion) {
    if (!categoriasDisponibles.length) return;
    const idxActual = categoriasDisponibles.findIndex(c => c.filtro === categoriaFiltro);
    const base = idxActual === -1 ? 0 : idxActual;
    const siguienteIdx = direccion === 'derecha'
        ? (base + 1) % categoriasDisponibles.length
        : (base - 1 + categoriasDisponibles.length) % categoriasDisponibles.length;

    aplicarCategoriaSeleccionada(categoriasDisponibles[siguienteIdx], { mostrarAviso: true });
}

function coincideCategoriaFiltro(canal, filtro) {
    if (!filtro || filtro === 'TODO') return true;
    const cat = normalizar(canal.categoria || '');
    const nom = normalizar(canal.nombre || '');
    const texto = `${cat} ${nom}`;

    if (filtro === 'NOTICIAS') {
        return /\b(news|noticia|noticias|24\/7|informacion|actualidad|canal de noticias|tn|a24|c5n|ln\+)\b/.test(texto);
    }
    if (filtro === 'DEPORTES') {
        return /\b(sport|sports|deporte|deportes|futbol|soccer|espn|tyc|fox sports|dsports|tnt sports|gol|motor)\b/.test(texto);
    }
    if (filtro === 'CINE_SERIES') {
        return /\b(movie|movies|pelicula|peliculas|cine|film|series|serie|novela|novelas|telenovela|tnt series|tnt novelas|amc|cinecanal|warner|star|space|fx)\b/.test(texto);
    }
    if (filtro === 'ENTRETENIMIENTO') {
        return /\b(entertainment|entretenimiento|variedades|general|show|reality|humor|comedia|comedy|lifestyle)\b/.test(texto);
    }
    if (filtro === 'MUSICA') {
        return /\b(music|musica|radio|fm|cumbia|cuarteto|rock|pop|urban|hits|mtv|htv|quiero)\b/.test(texto);
    }
    if (filtro === 'INFANTIL') {
        return /\b(kids|kid|infantil|animacion|animation|cartoon|disney|nick|pakapaka|plim plim|anime)\b/.test(texto);
    }
    return true;
}

function configurarDesplegableCategorias() {
    if (!el.btnFiltroCat || !el.filtroCatMenu) return;

    categoriasDisponibles = Array.from(el.filtroCatMenu.querySelectorAll('.filtro-cat-opcion'))
        .map(op => ({
            filtro: op.getAttribute('data-filtro') || 'TODO',
            etiqueta: op.textContent.trim(),
        }));

    el.btnFiltroCat.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        cerrarMenuIdiomas();
        alternarMenuCategorias();
    });

    el.filtroCatMenu.querySelectorAll('.filtro-cat-opcion').forEach(op => {
        op.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const item = {
                filtro: op.getAttribute('data-filtro') || 'TODO',
                etiqueta: op.textContent.trim(),
            };
            cerrarMenuCategorias();
            aplicarCategoriaSeleccionada(item, { mostrarAviso: false });
        });
    });

    document.addEventListener('click', (e) => {
        const wrap = document.getElementById('filter-dropdown-wrap');
        if (wrap && !wrap.contains(e.target)) {
            cerrarMenuCategorias();
        }
    });
}

/* ---------- Desplegable de idiomas cargados + Todos ---------- */
function cerrarMenuIdiomas() {
    if (!el.filtroLangMenu || !el.btnFiltroLang) return;
    el.filtroLangMenu.hidden = true;
    el.btnFiltroLang.setAttribute('aria-expanded', 'false');
}

function alternarMenuIdiomas(forzar) {
    if (!el.filtroLangMenu || !el.btnFiltroLang) return;
    const abrir = typeof forzar === 'boolean' ? forzar : el.filtroLangMenu.hidden;
    el.filtroLangMenu.hidden = !abrir;
    el.btnFiltroLang.setAttribute('aria-expanded', abrir ? 'true' : 'false');
}

/** Convierte lo que guarda la base ('Español', 'Ingles', 'Portuguese'…) en ES / EN / PT. */
function codigoIdioma(texto) {
    const t = normalizar(String(texto || '')).trim();
    if (!t) return '';
    if (/\b(espanol|spanish|castellano|spa|esp|es)\b/.test(t)) return 'ES';
    if (/\b(ingles|english|eng|en)\b/.test(t)) return 'EN';
    if (/\b(portugues|portuguese|por|pt)\b/.test(t)) return 'PT';
    return '';
}

/* Menú fijo: Todos, Español, Inglés y Portugués (con la cantidad de canales de cada uno) */
const IDIOMAS_FILTRO = [
    { valor: 'TODOS', etiqueta: 'Todos' },
    { valor: 'ES', etiqueta: 'Español' },
    { valor: 'EN', etiqueta: 'Inglés' },
    { valor: 'PT', etiqueta: 'Portugués' },
];

function poblarDesplegableIdiomas() {
    if (!el.filtroLangMenu) return;

    const conteo = { ES: 0, EN: 0, PT: 0 };
    todosLosCanales.forEach(c => { if (c && conteo[c._idioma] !== undefined) conteo[c._idioma]++; });

    el.filtroLangMenu.textContent = '';
    IDIOMAS_FILTRO.forEach(({ valor, etiqueta }) => {
        const activa = idiomaFiltro === valor;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'filtro-cat-opcion' + (activa ? ' activa' : '');
        btn.setAttribute('data-idioma', valor);
        btn.setAttribute('role', 'option');
        btn.setAttribute('aria-selected', activa ? 'true' : 'false');
        btn.textContent = valor === 'TODOS' ? etiqueta : `${etiqueta} (${conteo[valor]})`;

        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            idiomaFiltro = valor;
            if (el.filtroLangValor) el.filtroLangValor.textContent = etiqueta;
            el.filtroLangMenu.querySelectorAll('.filtro-cat-opcion').forEach(b => {
                const esActiva = b === btn;
                b.classList.toggle('activa', esActiva);
                b.setAttribute('aria-selected', esActiva ? 'true' : 'false');
            });
            cerrarMenuIdiomas();
            aplicarFiltros();
        });
        el.filtroLangMenu.appendChild(btn);
    });

    const actual = IDIOMAS_FILTRO.find(i => i.valor === idiomaFiltro) || IDIOMAS_FILTRO[0];
    if (el.filtroLangValor) el.filtroLangValor.textContent = actual.etiqueta;
}

function configurarDesplegableIdiomas() {
    if (!el.btnFiltroLang || !el.filtroLangMenu) return;

    el.btnFiltroLang.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        cerrarMenuCategorias();
        alternarMenuIdiomas();
    });

    document.addEventListener('click', (e) => {
        const wrap = document.getElementById('filter-lang-wrap');
        if (wrap && !wrap.contains(e.target)) {
            cerrarMenuIdiomas();
        }
    });
}

/* ---------- Solo TV tiene control de la lista principal ---------- */
function configurarBotonesCategoria() {
    document.querySelectorAll('.cat-btn').forEach(btn => {
        const cat = (btn.getAttribute('data-cat') || '').toUpperCase();
        if (cat === 'TV') {
            btn.classList.add('active');
            btn.addEventListener('click', () => {
                document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                canalesSeccion = todosLosCanales;
                aplicarFiltros();
            });
        } else {
            btn.classList.remove('active');
        }
    });
}

/* ---------- Control de audio (teclas 3, 4 y 5) ---------- */
function alternarMute() {
    if (!el.video) return;
    el.video.muted = !el.video.muted;
    mostrarAvisoTransitorio(el.video.muted ? 'mute activado' : 'mute desactivado');
}

function bajarVolumen() {
    if (!el.video) return;
    if (el.video.muted) el.video.muted = false;
    const nuevoVol = Math.max(0, Math.round((el.video.volume - PASO_VOLUMEN) * 100) / 100);
    el.video.volume = nuevoVol;
    mostrarAvisoTransitorio(`volumen ${Math.round(nuevoVol * 100)}% · bajando`);
}

function subirVolumen() {
    if (!el.video) return;
    if (el.video.muted) el.video.muted = false;
    const nuevoVol = Math.min(1, Math.round((el.video.volume + PASO_VOLUMEN) * 100) / 100);
    el.video.volume = nuevoVol;
    mostrarAvisoTransitorio(`volumen ${Math.round(nuevoVol * 100)}% · subiendo`);
}

/* ---------- Modo estabilidad manual (teclas 7, 8 y 9) ---------- */
function alternarModoEstabilidadConTecla7() {
    const activar = !player.modoColchon;
    player.modoColchon = activar;

    if (activar) {
        mostrarAvisoTransitorio(`Estabilidad activada (${colchonObjetivoSeg}s)`);
        const canal = obtenerCanalActualEfectivo();
        if (canal && canal.url && el.video) {
            if (obtenerSegundosBufferAdelantado() < colchonObjetivoSeg) {
                iniciarEsperaColchon('Acumulando colchón de estabilidad');
            }
        }
    } else {
        detenerEsperaColchon();
        mostrarAvisoTransitorio('Estabilidad desactivada');
        const canal = obtenerCanalActualEfectivo();
        if (canal && canal.url && el.video) {
            iniciarReproduccion();
        }
    }
}

function ajustarColchonEstabilidad(deltaSeg) {
    colchonObjetivoSeg = Math.min(
        COLCHON_MAX_SEG,
        Math.max(COLCHON_MIN_SEG, colchonObjetivoSeg + deltaSeg)
    );

    if (player.hls && player.hls.config) {
        const bufferObjetivo = Math.max(45, colchonObjetivoSeg + 15);
        player.hls.config.maxBufferLength = bufferObjetivo;
        player.hls.config.maxMaxBufferLength = bufferObjetivo + 20;
    }

    const estadoTexto = player.modoColchon ? '' : ' (inactivo)';
    mostrarAvisoTransitorio(`Colchón estabilidad: ${colchonObjetivoSeg}s${estadoTexto}`);

    if (player.modoColchon && canalActivo && canalActivo.url && el.video) {
        if (obtenerSegundosBufferAdelantado() < colchonObjetivoSeg && !player.esperandoColchon) {
            iniciarEsperaColchon('Acumulando colchón de estabilidad');
        }
    }
}

function obtenerSegundosBufferAdelantado() {
    const v = el.video;
    if (!v || !v.buffered || v.buffered.length === 0) return 0;
    const actual = v.currentTime || 0;
    for (let i = 0; i < v.buffered.length; i++) {
        const inicio = v.buffered.start(i);
        const fin = v.buffered.end(i);
        if (actual >= inicio - 0.5 && actual <= fin) {
            return Math.max(0, fin - actual);
        }
    }
    const primerFin = v.buffered.end(v.buffered.length - 1);
    return Math.max(0, primerFin - actual);
}

function detenerEsperaColchon() {
    player.esperandoColchon = false;
    clearInterval(player.timerColchon);
    clearTimeout(player.timerColchonTope);
    player.timerColchon = null;
    player.timerColchonTope = null;
}

function iniciarEsperaColchon(etiquetaBase = 'Acumulando colchón de estabilidad') {
    if (!el.video || !canalActivo) return;
    detenerEsperaColchon();

    player.esperandoColchon = true;
    const sesion = player.sesion;

    try { el.video.pause(); } catch (_) { /* ignorar */ }
    if (player.hls && typeof player.hls.startLoad === 'function') {
        try { player.hls.startLoad(); } catch (_) { /* ignorar */ }
    }

    const actualizarProgreso = () => {
        if (sesion !== player.sesion || !player.esperandoColchon || !player.modoColchon) {
            detenerEsperaColchon();
            return;
        }
        const cargado = obtenerSegundosBufferAdelantado();
        const segs = Math.min(colchonObjetivoSeg, Math.floor(cargado));
        mostrarOverlay('cargando', `${etiquetaBase}… ${segs}s / ${colchonObjetivoSeg}s`);

        if (cargado >= colchonObjetivoSeg) {
            detenerEsperaColchon();
            ocultarOverlay();
            intentarPlay();
        }
    };

    actualizarProgreso();
    player.timerColchon = setInterval(actualizarProgreso, 400);

    const maxEsperaMs = Math.max(18000, colchonObjetivoSeg * 1400);
    player.timerColchonTope = setTimeout(() => {
        if (sesion !== player.sesion || !player.esperandoColchon) return;
        detenerEsperaColchon();
        ocultarOverlay();
        intentarPlay();
    }, maxEsperaMs);
}

/* ---------- Avisos transitorios ---------- */
function mostrarAvisoEnPosicion(texto, duracionMs = 2500) {
    if (!el.shortcutAviso) return;
    el.shortcutAviso.textContent = texto;
    el.shortcutAviso.hidden = false;
    el.shortcutAviso.style.display = 'block';
    clearTimeout(timerShortcutAviso);
    timerShortcutAviso = setTimeout(() => {
        el.shortcutAviso.hidden = true;
        el.shortcutAviso.style.display = '';
    }, duracionMs);
}

function mostrarAvisoTransitorio(texto, duracionMs = 2500) {
    if (estaEnPantallaCompleta()) {
        mostrarAvisoPantallaCompleta(texto, duracionMs);
    } else {
        mostrarAvisoEnPosicion(texto, duracionMs);
    }
}

function estaEnPantallaCompleta() {
    return Boolean(
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        (el.video && el.video.webkitDisplayingFullscreen)
    );
}

function liberarFocoPantallaCompleta() {
    if (!estaEnPantallaCompleta()) return;
    try {
        if (document.activeElement && typeof document.activeElement.blur === 'function') {
            document.activeElement.blur();
        }
        if (el.video && typeof el.video.blur === 'function') {
            el.video.blur();
        }
    } catch (e) { /* ignorar */ }
}

function asegurarDialogPantallaCompleta() {
    if (avisoFsDialog) return avisoFsDialog;
    const dlg = document.createElement('dialog');
    dlg.id = 'xuper-fs-dialog';
    Object.assign(dlg.style, {
        position: 'fixed',
        top: '28px',
        left: '28px',
        margin: '0',
        padding: '12px 18px',
        borderRadius: '10px',
        background: 'rgba(8, 16, 31, 0.92)',
        color: '#f8fafc',
        border: '1px solid rgba(245, 158, 11, 0.8)',
        fontFamily: 'Segoe UI, sans-serif',
        fontSize: '1.05rem',
        fontWeight: '600',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.65)',
        outline: 'none',
        pointerEvents: 'none',
        zIndex: '2147483647',
    });

    const style = document.createElement('style');
    style.textContent = `
        #xuper-fs-dialog::backdrop {
            background: transparent !important;
        }
    `;
    document.head.appendChild(style);
    document.body.appendChild(dlg);
    avisoFsDialog = dlg;
    return dlg;
}

function mostrarAvisoPantallaCompleta(texto, duracionMs = 2500) {
    const dlg = asegurarDialogPantallaCompleta();
    dlg.textContent = texto;

    try {
        if (!dlg.open) {
            if (typeof dlg.showModal === 'function') {
                dlg.showModal();
                liberarFocoPantallaCompleta();
            } else if (typeof dlg.show === 'function') {
                dlg.show();
            }
        }
    } catch (e) {
        try {
            if (typeof dlg.show === 'function' && !dlg.open) dlg.show();
        } catch (_) { /* ignorar */ }
    }

    clearTimeout(avisoFsTimer);
    avisoFsTimer = setTimeout(() => {
        if (dlg && dlg.open && typeof dlg.close === 'function') {
            try { dlg.close(); } catch (_) { /* ignorar */ }
        }
    }, duracionMs);
}

/* ---------- Canales favoritos efectivos para recorrer ---------- */
function obtenerCanalesFavoritosDisponibles() {
    if (!Array.isArray(favoritos) || !favoritos.length) return [];
    const lista = favoritos
        .map(u => canalPorUrl.get(u))
        .filter(Boolean);
    if (!ocultarCaidos) return lista;
    return lista.filter(c => c.estado !== 'caido');
}

function obtenerListaRecorridoActiva() {
    if (modoRecorrido === 'favoritos') {
        const favs = obtenerCanalesFavoritosDisponibles();
        if (favs.length > 0) return favs;
        modoRecorrido = 'principal';
    }
    return canalesVisibles;
}

function alternarModoRecorridoConTecla2() {
    const favs = obtenerCanalesFavoritosDisponibles();

    if (modoRecorrido === 'favoritos') {
        modoRecorrido = 'principal';
        mostrarAvisoTransitorio('recorriendo lista principal');
        return;
    }

    if (!favs.length) {
        modoRecorrido = 'principal';
        mostrarAvisoTransitorio('favoritos vacíos · recorriendo lista principal');
        return;
    }

    modoRecorrido = 'favoritos';
    mostrarAvisoTransitorio('recorriendo lista favoritos');
}

/* ---------- Navegación con flechas y shortcuts 1..9 ---------- */
function configurarTecladoCanales() {
    const alCambiarFs = () => {
        setTimeout(liberarFocoPantallaCompleta, 30);
        if (!estaEnPantallaCompleta() && avisoFsDialog && avisoFsDialog.open) {
            try { avisoFsDialog.close(); } catch (_) { /* ignorar */ }
        }
    };

    document.addEventListener('fullscreenchange', alCambiarFs);
    document.addEventListener('webkitfullscreenchange', alCambiarFs);
    if (el.video) {
        el.video.addEventListener('webkitbeginfullscreen', () => {
            setTimeout(liberarFocoPantallaCompleta, 30);
        });
        el.video.addEventListener('webkitendfullscreen', alCambiarFs);
    }

    const manejarTecla = (e) => {
        if (e.ctrlKey || e.altKey || e.metaKey) return;

        const esUno = e.key === '1' || e.code === 'Digit1' || e.code === 'Numpad1';
        const esDos = e.key === '2' || e.code === 'Digit2' || e.code === 'Numpad2';
        const esTres = e.key === '3' || e.code === 'Digit3' || e.code === 'Numpad3';
        const esCuatro = e.key === '4' || e.code === 'Digit4' || e.code === 'Numpad4';
        const esCinco = e.key === '5' || e.code === 'Digit5' || e.code === 'Numpad5';
        const esSiete = e.key === '7' || e.code === 'Digit7' || e.code === 'Numpad7';
        const esOcho = e.key === '8' || e.code === 'Digit8' || e.code === 'Numpad8';
        const esNueve = e.key === '9' || e.code === 'Digit9' || e.code === 'Numpad9';
        const esFlechaVertical = e.key === 'ArrowDown' || e.key === 'ArrowUp';
        const esIzquierda = e.key === 'ArrowLeft';
        const esDerecha = e.key === 'ArrowRight';

        if (!esUno && !esDos && !esTres && !esCuatro && !esCinco && !esSiete && !esOcho && !esNueve && !esFlechaVertical && !esIzquierda && !esDerecha) {
            return;
        }

        const enFs = estaEnPantallaCompleta();
        const activo = document.activeElement;
        if (!enFs && activo && (
            activo.tagName === 'INPUT' ||
            activo.tagName === 'TEXTAREA' ||
            activo.tagName === 'SELECT' ||
            activo.isContentEditable
        )) {
            return;
        }

        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') {
            e.stopImmediatePropagation();
        }
        if (enFs) liberarFocoPantallaCompleta();

        if (esUno) {
            const canal = obtenerCanalActualEfectivo();
            if (!canal) {
                avisarSinCanal();
                return;
            }
            alternarFavorito(canal, { abrirPanel: false });
            return;
        }

        if (esDos) {
            alternarModoRecorridoConTecla2();
            return;
        }

        if (esTres) {
            alternarMute();
            return;
        }

        if (esCuatro) {
            bajarVolumen();
            return;
        }

        if (esCinco) {
            subirVolumen();
            return;
        }

        if (esSiete) {
            alternarModoEstabilidadConTecla7();
            return;
        }

        if (esOcho) {
            ajustarColchonEstabilidad(-COLCHON_PASO_SEG);
            return;
        }

        if (esNueve) {
            ajustarColchonEstabilidad(COLCHON_PASO_SEG);
            return;
        }

        if (esIzquierda) {
            navegarCategoriaConFlecha('izquierda');
            return;
        }

        if (esDerecha) {
            navegarCategoriaConFlecha('derecha');
            return;
        }

        const lista = obtenerListaRecorridoActiva();
        if (!lista.length) return;

        const actual = obtenerCanalActualEfectivo();
        const idxActual = actual
            ? lista.findIndex(c => Number(c.id) === Number(actual.id))
            : -1;

        let siguienteIdx;
        if (idxActual === -1) {
            siguienteIdx = e.key === 'ArrowDown' ? 0 : lista.length - 1;
        } else if (e.key === 'ArrowDown') {
            siguienteIdx = (idxActual + 1) % lista.length;
        } else {
            siguienteIdx = (idxActual - 1 + lista.length) % lista.length;
        }

        const destino = lista[siguienteIdx];
        if (!destino) return;

        reproducirCanal(destino);

        if (modoRecorrido === 'favoritos') {
            if (el.favPanel && el.favPanel.dataset.abierto === 'true' && el.favLista) {
                const filaDest = filasFav.get(destino.id);
                if (filaDest) {
                    el.favLista.scrollTop = Math.max(0, filaDest.offsetTop - el.favLista.offsetTop - 8);
                }
            }
        } else {
            const cardDestino = asegurarTarjetaEnDOM(destino.id);
            if (cardDestino) {
                cardDestino.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        }

        if (enFs) {
            mostrarAvisoPantallaCompleta(`▶ ${destino.nombre || 'Canal'}`);
        }
    };

    window.addEventListener('keydown', manejarTecla, true);
    document.addEventListener('keydown', manejarTecla, true);
    if (el.video) {
        el.video.addEventListener('keydown', manejarTecla, true);
    }
}

/** Resuelve el canal activo incluso si se seleccionó desde la lista o el título. */
function obtenerCanalActualEfectivo() {
    if (canalActivo && canalActivo.url) return canalActivo;

    const cardActiva = document.querySelector('.channel-card-tv.playing');
    if (cardActiva) {
        const c = canalPorId.get(Number(cardActiva.dataset.id));
        if (c) {
            canalActivo = c;
            return c;
        }
    }

    if (el.titulo) {
        const limpio = el.titulo.textContent
            .replace(/^▶\s*/, '')
            .replace(/\s*\(fuente alternativa\)\s*$/i, '')
            .trim();
        if (limpio && limpio !== 'Selecciona un canal') {
            const encontrado = todosLosCanales.find(c => (c.nombre || '').trim() === limpio);
            if (encontrado) {
                canalActivo = encontrado;
                return encontrado;
            }
        }
    }

    return null;
}

function configurarBotonCorazonBarra() {
    const botones = [el.btnCorazonBarra, el.btnCorazon].filter(Boolean);
    botones.forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const canal = obtenerCanalActualEfectivo();
            if (!canal) {
                avisarSinCanal();
                return;
            }
            alternarFavorito(canal, { abrirPanel: true });
        });
    });
}

/* ---------- Carga y filtrado de canales ---------- */
async function cargarCanalesIniciales() {
    try {
        const respuesta = await fetch(`${API_URL}/canales`);
        if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);

        const datos = await respuesta.json();
        todosLosCanales = Array.isArray(datos) ? datos : [];
        canalPorId.clear();
        canalPorUrl.clear();

        todosLosCanales.forEach((c, idx) => {
            if (!c || typeof c !== 'object') return;
            if (c.id === undefined || c.id === null) c.id = idx + 1;
            c.id = Number(c.id);
            c._busqueda = normalizar(`${c.nombre || ''} ${c.categoria || ''} ${c.idioma || ''}`);
            c._clave = claveCanal(c.nombre);
            c._idioma = codigoIdioma(c.idioma);
            canalPorId.set(c.id, c);
            if (c.url) canalPorUrl.set(c.url, c);
        });

        canalesSeccion = todosLosCanales;
        poblarDesplegableIdiomas();
        aplicarFiltros();
        renderizarFavoritos();
        actualizarBotonCorazon();
    } catch (error) {
        console.error('Error cargando canales:', error);
        mostrarMensajeLista('No se pudieron cargar los canales.', true);
    }
}

function aplicarFiltros() {
    let lista = canalesSeccion;
    if (categoriaFiltro && categoriaFiltro !== 'TODO') {
        lista = lista.filter(c => coincideCategoriaFiltro(c, categoriaFiltro));
    }
    if (idiomaFiltro && idiomaFiltro !== 'TODOS') {
        lista = lista.filter(c => c._idioma === idiomaFiltro);
    }
    if (ocultarCaidos) lista = lista.filter(c => c.estado !== 'caido');
    if (textoBusqueda) {
        const q = normalizar(textoBusqueda);
        lista = lista.filter(c => c._busqueda.includes(q));
    }
    lista = lista.slice().sort((a, b) => ORDEN_ESTADO[estadoDe(a)] - ORDEN_ESTADO[estadoDe(b)]);
    canalesVisibles = lista;
    renderizarGrilla(lista);
}

/* ---------- Render progresivo de la lista ---------- */
function mostrarMensajeLista(texto, conReintento) {
    canalesVisibles = [];
    indiceRenderizado = 0;
    tarjetas.clear();
    tarjetaActiva = null;
    if (!el.grilla) return;
    el.grilla.textContent = '';
    const caja = document.createElement('div');
    caja.className = 'lista-mensaje';
    caja.textContent = texto;
    if (conReintento) {
        const btn = document.createElement('button');
        btn.className = 'btn-secundario';
        btn.textContent = 'Reintentar';
        btn.addEventListener('click', cargarCanalesIniciales);
        caja.appendChild(btn);
    }
    el.grilla.appendChild(caja);
    if (el.stats) el.stats.textContent = '';
}

function renderizarSiguienteLote(cantidad) {
    if (!el.grilla || indiceRenderizado >= canalesVisibles.length) return;
    const hasta = Math.min(indiceRenderizado + cantidad, canalesVisibles.length);
    const fragmento = document.createDocumentFragment();

    for (let i = indiceRenderizado; i < hasta; i++) {
        const canal = canalesVisibles[i];
        try {
            const card = crearTarjeta(canal);
            if (canalActivo && Number(canal.id) === Number(canalActivo.id)) {
                tarjetaActiva = card;
                card.classList.add('playing');
            }
            fragmento.appendChild(card);
        } catch (e) {
            console.warn('Error al crear tarjeta de canal:', canal, e);
        }
    }

    el.grilla.appendChild(fragmento);
    indiceRenderizado = hasta;
}

function renderizarGrilla(canales) {
    tarjetas.clear();
    tarjetaActiva = null;
    indiceRenderizado = 0;
    if (!el.grilla) return;
    el.grilla.textContent = '';
    el.grilla.scrollTop = 0;

    if (!canales.length) {
        mostrarMensajeLista('No hay canales para mostrar.', false);
        return;
    }

    renderizarSiguienteLote(LOTE_INICIAL_CANALES);

    const caidos = canales.filter(c => c.estado === 'caido').length;
    const enLinea = canales.filter(c => c.estado === 'ok').length;
    if (el.stats) {
        el.stats.textContent = `${canales.length} canales · ${enLinea} en línea · ${caidos} caídos`;
    }
}

function crearTarjeta(canal, { favorito = false } = {}) {
    const card = document.createElement('div');
    card.className = 'channel-card-tv';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.dataset.id = canal.id;

    const thumb = document.createElement('div');
    thumb.className = 'channel-thumb-tv';
    const ponerIcono = () => { thumb.textContent = '📺'; };
    if (canal.logo && /^https?:\/\//i.test(canal.logo)) {
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        img.addEventListener('error', ponerIcono);
        img.src = canal.logo;
        thumb.appendChild(img);
    } else {
        ponerIcono();
    }

    const info = document.createElement('div');
    info.className = 'channel-info-tv';
    const nombre = document.createElement('h4');
    nombre.textContent = canal.nombre || 'Canal';
    const sub = document.createElement('span');
    sub.className = 'channel-estado-texto';
    info.appendChild(nombre);
    info.appendChild(sub);

    const punto = document.createElement('span');
    punto.className = 'estado-dot';

    card.appendChild(thumb);
    card.appendChild(info);
    card.appendChild(punto);

    if (favorito) {
        card.classList.add('fav-item');
        const quitar = document.createElement('button');
        quitar.type = 'button';
        quitar.className = 'fav-quitar';
        quitar.textContent = '✕';
        quitar.title = 'Quitar de favoritos';
        quitar.setAttribute('aria-label', `Quitar ${canal.nombre || 'canal'} de favoritos`);
        quitar.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            quitarFavorito(canal);
        });
        card.appendChild(quitar);
    }

    pintarEstado(card, canal);

    const abrir = () => reproducirCanal(canal);
    card.addEventListener('click', abrir);
    card.addEventListener('keydown', (e) => {
        if (e.target !== card) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrir(); }
    });

    (favorito ? filasFav : tarjetas).set(canal.id, card);
    return card;
}

function pintarEstado(card, canal) {
    const estado = estadoDe(canal);
    card.classList.remove('estado-ok', 'estado-caido', 'estado-desconocido');
    card.classList.add(`estado-${estado}`);
    const texto = ESTADO_TEXTO[estado];
    const dot = card.querySelector('.estado-dot');
    const sub = card.querySelector('.channel-estado-texto');
    if (dot) dot.title = texto;
    if (sub) sub.textContent = estado === 'ok' ? '' : texto;
    card.setAttribute('aria-label', `${canal.nombre || 'Canal'}, ${texto}`);
}

function actualizarEstadoCanal(id, estado) {
    const canal = canalPorId.get(id);
    if (!canal || !estado) return;
    canal.estado = estado;
    const card = tarjetas.get(id);
    if (card) pintarEstado(card, canal);
    const fila = filasFav.get(id);
    if (fila) pintarEstado(fila, canal);
}

function marcarTarjetaActiva() {
    if (tarjetaActiva) tarjetaActiva.classList.remove('playing');
    tarjetaActiva = canalActivo ? tarjetas.get(canalActivo.id) || null : null;
    if (tarjetaActiva) tarjetaActiva.classList.add('playing');
    marcarFilaFavActiva();
}

function marcarFilaFavActiva() {
    if (filaFavActiva) filaFavActiva.classList.remove('playing');
    filaFavActiva = canalActivo ? filasFav.get(canalActivo.id) || null : null;
    if (filaFavActiva) filaFavActiva.classList.add('playing');
}

/* =====================================================================
   FAVORITOS (CORAZÓN JUNTO A LA BARRA DE FAVORITOS + LOCALSTORAGE)
   ===================================================================== */
function leerFavoritos() {
    try {
        const datos = JSON.parse(leerPref(STORAGE_FAVORITOS) || '[]');
        const limpios = Array.isArray(datos)
            ? datos.filter(u => typeof u === 'string' && u.trim().length > 0)
            : [];
        favoritosMemoria = limpios.slice();
        return limpios;
    } catch (e) {
        return favoritosMemoria.slice();
    }
}

function guardarFavoritos() {
    favoritosMemoria = favoritos.slice();
    guardarPref(STORAGE_FAVORITOS, JSON.stringify(favoritos));
}

function esFavorito(canal) {
    return Boolean(canal && canal.url && favoritos.includes(canal.url));
}

function mostrarAvisoFavorito(texto, duracionMs = 3500) {
    if (!el.favAviso) return;
    el.favAviso.textContent = texto;
    el.favAviso.hidden = false;
    el.favAviso.style.display = 'block';
    clearTimeout(timerAviso);
    timerAviso = setTimeout(() => {
        el.favAviso.hidden = true;
        el.favAviso.style.display = '';
    }, duracionMs);
}

function alternarFavorito(canal, { abrirPanel = true } = {}) {
    if (!canal || !canal.url) {
        mostrarAvisoFavorito('Este canal no tiene una URL válida para guardar en favoritos.');
        return;
    }

    const i = favoritos.indexOf(canal.url);
    const agregado = i === -1;
    if (agregado) favoritos.push(canal.url);
    else favoritos.splice(i, 1);

    guardarFavoritos();
    actualizarBotonCorazon();
    renderizarFavoritos();

    if (modoRecorrido === 'favoritos' && !obtenerCanalesFavoritosDisponibles().length) {
        modoRecorrido = 'principal';
    }

    if (agregado) {
        animarCorazon(el.btnCorazonBarra, true);
        animarCorazon(el.btnCorazon, true);
        if (abrirPanel && el.favPanel && el.favPanel.dataset.abierto !== 'true') {
            alternarPanelFavoritos(true);
        }
        mostrarAvisoTransitorio('agregado a favoritos');
    } else {
        mostrarAvisoTransitorio('eliminado de favoritos');
    }
}

function quitarFavorito(canal) {
    if (!canal || !canal.url) return;
    alternarFavorito(canal, { abrirPanel: false });
}

function aplicarColorCorazon(boton, fav) {
    if (!boton) return;
    boton.style.color = fav ? '#ef4444' : '#cbd5e1';
    const path = boton.querySelector('path');
    if (path) {
        path.style.fill = fav ? '#ef4444' : 'transparent';
        path.style.stroke = fav ? '#ef4444' : '#cbd5e1';
        path.style.strokeWidth = '2.2';
    }
}

function actualizarBotonCorazon() {
    const canalRef = obtenerCanalActualEfectivo();
    const fav = canalRef ? esFavorito(canalRef) : false;
    const texto = fav ? 'Quitar de favoritos' : 'Agregar a favoritos';

    if (el.btnCorazon) {
        el.btnCorazon.hidden = !canalRef;
        el.btnCorazon.classList.toggle('activo', fav);
        el.btnCorazon.setAttribute('aria-pressed', fav ? 'true' : 'false');
        el.btnCorazon.setAttribute('aria-label', texto);
        el.btnCorazon.title = texto;
        aplicarColorCorazon(el.btnCorazon, fav);
    }

    if (el.btnCorazonBarra) {
        el.btnCorazonBarra.classList.toggle('sin-canal', !canalRef);
        el.btnCorazonBarra.classList.toggle('activo', fav);
        el.btnCorazonBarra.setAttribute('aria-pressed', fav ? 'true' : 'false');
        el.btnCorazonBarra.setAttribute('aria-label', texto);
        el.btnCorazonBarra.title = canalRef ? texto : 'Agregar a favoritos (elegí un canal primero)';
        aplicarColorCorazon(el.btnCorazonBarra, fav);
    }
}

function avisarSinCanal() {
    const b = el.btnCorazonBarra;
    if (b) {
        b.classList.remove('sacudir');
        void b.offsetWidth;
        b.classList.add('sacudir');
    }
    mostrarAvisoTransitorio('Primero elegí un canal de la lista para poder agregarlo a favoritos.');
}

function animarCorazon(b, particulas = true) {
    if (!b) return;
    b.classList.remove('latido');
    void b.offsetWidth;
    b.classList.add('latido');
    if (!particulas) return;

    const total = 6;
    for (let i = 0; i < total; i++) {
        const mini = document.createElement('span');
        mini.className = 'mini-corazon';
        mini.textContent = '♥';
        const angulo = (Math.PI * 2 * i) / total + Math.random() * 0.5;
        const distancia = 26 + Math.random() * 12;
        mini.style.setProperty('--dx', `${Math.cos(angulo) * distancia}px`);
        mini.style.setProperty('--dy', `${Math.sin(angulo) * distancia}px`);
        mini.addEventListener('animationend', () => mini.remove());
        b.appendChild(mini);
    }
}

function alternarPanelFavoritos(forzarEstado) {
    if (!el.favPanel || !el.btnFavoritos) return;
    const abrir = typeof forzarEstado === 'boolean'
        ? forzarEstado
        : el.favPanel.dataset.abierto !== 'true';
    el.favPanel.dataset.abierto = abrir ? 'true' : 'false';
    el.favPanel.inert = !abrir;
    el.btnFavoritos.setAttribute('aria-expanded', abrir ? 'true' : 'false');
}

function renderizarFavoritos() {
    if (!el.favLista) return;
    filasFav.clear();
    filaFavActiva = null;
    el.favLista.textContent = '';

    const canales = favoritos.slice().reverse().map(u => canalPorUrl.get(u)).filter(Boolean);
    const cargando = canalPorUrl.size === 0 && favoritos.length > 0;
    if (el.favCount) {
        el.favCount.textContent = cargando ? favoritos.length : canales.length;
    }

    if (!canales.length) {
        const vacio = document.createElement('div');
        vacio.className = 'favoritos-vacio';
        vacio.textContent = cargando
            ? 'Cargando favoritos…'
            : 'Todavía no tenés favoritos. Tocá el corazón al lado de Favoritos para guardar el canal actual.';
        el.favLista.appendChild(vacio);
        return;
    }

    const fragmento = document.createDocumentFragment();
    canales.forEach(canal => fragmento.appendChild(crearTarjeta(canal, { favorito: true })));
    el.favLista.appendChild(fragmento);
    marcarFilaFavActiva();
}

/* =====================================================================
   REPRODUCTOR
   ===================================================================== */
function tipoDeUrl(url) {
    if (/m3u8/i.test(url)) return 'hls';
    if (/\.(mp4|webm|ogv|ogg|mp3|aac|m4a)(\?|#|$)/i.test(url)) return 'directo';
    return 'auto';
}

function mostrarOverlay(tipo, texto) {
    if (!el.overlay || !el.msg) return;
    clearTimeout(player.timerSpinner);
    el.overlay.hidden = false;
    el.overlay.dataset.tipo = tipo;
    if (el.spinner) el.spinner.hidden = tipo !== 'cargando';
    if (el.acciones) el.acciones.hidden = tipo !== 'error';
    el.msg.textContent = texto;
}

function ocultarOverlay() {
    if (!el.overlay) return;
    clearTimeout(player.timerSpinner);
    el.overlay.hidden = true;
}

function armarWatchdog(ms) {
    clearTimeout(player.watchdog);
    player.watchdog = setTimeout(() => programarReintento('sin datos'), ms);
}

function desarmarWatchdog() {
    clearTimeout(player.watchdog);
    player.watchdog = null;
}

function limpiarMotor() {
    player.sesion++;
    detenerEsperaColchon();
    clearTimeout(player.timerReintento);
    clearTimeout(player.watchdog);
    clearTimeout(player.timerEstable);
    clearTimeout(player.timerSpinner);
    if (player.hls) {
        try { player.hls.destroy(); } catch (e) { /* ya destruido */ }
        player.hls = null;
    }
    player.modo = null;
    const v = el.video;
    if (v) {
        v.pause();
        v.removeAttribute('src');
        v.load();
    }
}

function reproducirCanal(canal, { automatico = false, manual = false } = {}) {
    if (!canal || !canal.url) return;
    if (el.favAviso) {
        el.favAviso.hidden = true;
        el.favAviso.style.display = '';
    }
    if (!automatico && !manual) player.fuentesProbadas.clear();
    player.fuentesProbadas.add(canal.id);

    canalActivo = canal;
    player.intento = 0;
    player.recuperacionesMedia = 0;
    player.forzarDirecto = false;
    player.esperandoRed = false;

    if (el.titulo) {
        el.titulo.textContent = `▶ ${canal.nombre}${automatico ? ' (fuente alternativa)' : ''}`;
    }
    asegurarTarjetaEnDOM(canal.id);
    marcarTarjetaActiva();
    actualizarBotonCorazon();
    iniciarReproduccion();
}

function iniciarReproduccion() {
    const canal = canalActivo;
    if (!canal || !canal.url || !el.video) return;

    limpiarMotor();
    const sesion = player.sesion;
    const video = el.video;
    const tipo = tipoDeUrl(canal.url);
    const conColchon = player.modoColchon;
    const bufferObjetivo = conColchon ? Math.max(45, colchonObjetivoSeg + 15) : 30;

    mostrarOverlay('cargando', player.intento
        ? `Reconectando… intento ${player.intento} de ${MAX_REINTENTOS}`
        : (conColchon ? `Acumulando colchón de estabilidad… 0s / ${colchonObjetivoSeg}s` : 'Cargando canal…'));
    armarWatchdog(TIMEOUT_ARRANQUE_MS);

    const usarHlsJs = tipo !== 'directo' && !player.forzarDirecto && window.Hls && Hls.isSupported();

    if (usarHlsJs) {
        player.modo = 'hls';
        const hls = new Hls({
            enableWorker: true,
            manifestLoadingTimeOut: 10000,
            manifestLoadingMaxRetry: 2,
            levelLoadingTimeOut: 10000,
            levelLoadingMaxRetry: 3,
            fragLoadingTimeOut: 20000,
            fragLoadingMaxRetry: 4,
            maxBufferLength: bufferObjetivo,
            maxMaxBufferLength: bufferObjetivo + 20,
            backBufferLength: 30,
        });
        player.hls = hls;
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (sesion !== player.sesion) return;
            if (player.modoColchon) {
                iniciarEsperaColchon('Acumulando colchón de estabilidad');
            } else {
                intentarPlay();
            }
        });
        hls.on(Hls.Events.ERROR, (_evt, data) => manejarErrorHls(data, sesion, tipo === 'auto'));
        hls.attachMedia(video);
        hls.loadSource(canal.url);
    } else {
        player.modo = 'nativo';
        video.src = canal.url;
        video.load();
        if (player.modoColchon) {
            iniciarEsperaColchon('Acumulando colchón de estabilidad');
        } else {
            intentarPlay();
        }
    }
}

function intentarPlay() {
    if (!el.video) return;
    const p = el.video.play();
    if (p && p.catch) {
        p.catch(err => {
            if (err && err.name === 'NotAllowedError') {
                desarmarWatchdog();
                mostrarOverlay('info', 'Tocá ▶ para empezar a reproducir.');
            }
        });
    }
}

function manejarErrorHls(data, sesion, esAuto) {
    if (sesion !== player.sesion || !data || !data.fatal) return;
    const { ErrorTypes, ErrorDetails } = Hls;

    if (esAuto && !player.forzarDirecto && data.details === ErrorDetails.MANIFEST_PARSING_ERROR) {
        player.forzarDirecto = true;
        iniciarReproduccion();
        return;
    }

    if (data.type === ErrorTypes.MEDIA_ERROR && player.recuperacionesMedia < MAX_RECUPERACIONES_MEDIA) {
        player.recuperacionesMedia++;
        if (player.recuperacionesMedia === 2 && player.hls) player.hls.swapAudioCodec();
        if (player.hls) player.hls.recoverMediaError();
        mostrarOverlay('cargando', 'Recuperando la reproducción…');
        armarWatchdog(TIMEOUT_CORTE_MS);
        return;
    }

    programarReintento(data.details || data.type);
}

function programarReintento(motivo) {
    if (!canalActivo) return;
    limpiarMotor();
    console.warn('Reintento por:', motivo);

    if (!navigator.onLine) {
        player.esperandoRed = true;
        mostrarOverlay('error', 'Sin conexión a internet. Se reanudará cuando vuelva la red.');
        return;
    }
    if (player.intento >= MAX_REINTENTOS) {
        falloDefinitivo();
        return;
    }

    const espera = BACKOFF_MS[player.intento];
    player.intento++;
    mostrarOverlay('cargando', `Reconectando… intento ${player.intento} de ${MAX_REINTENTOS}`);
    player.timerReintento = setTimeout(iniciarReproduccion, espera);
}

function buscarAlternativa(canal) {
    if (!canal._clave) return null;
    return todosLosCanales.find(c =>
        c.id !== canal.id &&
        c._clave === canal._clave &&
        c.estado !== 'caido' &&
        !player.fuentesProbadas.has(c.id)
    ) || null;
}

async function verificarEnServidor(id) {
    try {
        const r = await fetch(`${API_URL}/canales/${id}/verificar`, { method: 'POST' });
        if (!r.ok) return null;
        return await r.json();
    } catch (e) {
        return null;
    }
}

async function falloDefinitivo() {
    const canal = canalActivo;
    if (!canal) return;
    const sesion = player.sesion;

    const alternativa = buscarAlternativa(canal);
    if (alternativa) {
        mostrarOverlay('cargando', `No responde. Probando otra fuente de ${canal.nombre}…`);
        verificarEnServidor(canal.id).then(r => r && actualizarEstadoCanal(canal.id, r.estado));
        player.timerReintento = setTimeout(() => {
            if (sesion === player.sesion) reproducirCanal(alternativa, { automatico: true });
        }, 900);
        return;
    }

    mostrarOverlay('error', 'No se pudo reproducir este canal. Verificando…');
    const res = await verificarEnServidor(canal.id);
    if (sesion !== player.sesion || canalActivo !== canal) return;

    if (res) actualizarEstadoCanal(canal.id, res.estado);
    let texto = 'No se pudo reproducir este canal.';
    if (res && res.estado === 'caido') {
        texto = 'Canal caído: tampoco responde desde el servidor.';
    } else if (res && res.estado === 'ok') {
        texto = 'El servidor ve el canal activo, pero tu navegador no pudo reproducirlo ' +
                '(formato no compatible, CORS o stream http en una página https).';
    }
    mostrarOverlay('error', texto);
}

function configurarEventosVideo() {
    const v = el.video;
    if (!v) return;

    v.addEventListener('playing', () => {
        if (!player.modo) return;
        desarmarWatchdog();
        ocultarOverlay();
        clearTimeout(player.timerEstable);
        player.timerEstable = setTimeout(() => {
            player.intento = 0;
            player.recuperacionesMedia = 0;
        }, ESTABLE_TRAS_MS);
    });

    v.addEventListener('waiting', () => {
        if (!player.modo || v.paused || player.esperandoColchon) return;
        clearTimeout(player.timerEstable);
        clearTimeout(player.timerSpinner);
        player.timerSpinner = setTimeout(() => mostrarOverlay('cargando', 'Cargando…'), 500);
        armarWatchdog(TIMEOUT_CORTE_MS);
    });

    v.addEventListener('ended', () => {
        if (player.modo) programarReintento('fin de transmisión');
    });

    v.addEventListener('error', () => {
        if (player.modo === 'nativo') programarReintento('error de video');
    });
}