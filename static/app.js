/* =====================================================================
   Sealto TV - front
   ===================================================================== */
const API_URL = '/api';

const ORDEN_ESTADO = { ok: 0, desconocido: 1, caido: 2 };
const ESTADO_TEXTO = { ok: 'En línea', caido: 'Caído', desconocido: 'Sin verificar' };
const STORAGE_FAVORITOS = 'xuper_tv_favoritos_v1';
const PASO_VOLUMEN = 0.1;

const LOTE_INICIAL_CANALES = 45;
const LOTE_SCROLL_CANALES = 35;
const MARGEN_SCROLL_PX = 240;

const BACKOFF_MS = [2000, 4000, 8000, 15000];
const MAX_REINTENTOS = BACKOFF_MS.length;
const TIMEOUT_ARRANQUE_MS = 20000;
const TIMEOUT_CORTE_MS = 15000;
const ESTABLE_TRAS_MS = 20000;
const MAX_RECUPERACIONES_MEDIA = 2;

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
let inicioAutomaticoPendiente = true;

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
let timerInicioCanal = null;

let modoRecorrido = 'principal';

const canalPorId = new Map();
const canalPorUrl = new Map();
const tarjetas = new Map();
let tarjetaActiva = null;

let favoritos = [];
let usuario = null;
let ultimaSincronizacionFav = 0;
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

function crearIconoTachoSvg() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');

    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    poly.setAttribute('points', '3 6 5 6 21 6');
    svg.appendChild(poly);

    const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path1.setAttribute('d', 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6');
    svg.appendChild(path1);

    const line1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line1.setAttribute('x1', '10');
    line1.setAttribute('y1', '11');
    line1.setAttribute('x2', '10');
    line1.setAttribute('y2', '17');
    svg.appendChild(line1);

    const line2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line2.setAttribute('x1', '14');
    line2.setAttribute('y1', '11');
    line2.setAttribute('x2', '14');
    line2.setAttribute('y2', '17');
    svg.appendChild(line2);

    const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path2.setAttribute('d', 'M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2');
    svg.appendChild(path2);

    return svg;
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
        configurarSesionUI();
        cargarSesion();

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

function codigoIdioma(texto) {
    const t = normalizar(String(texto || '')).trim();
    if (!t) return '';
    if (/\b(espanol|spanish|castellano|spa|esp|es)\b/.test(t)) return 'ES';
    if (/\b(ingles|english|eng|en)\b/.test(t)) return 'EN';
    if (/\b(portugues|portuguese|por|pt)\b/.test(t)) return 'PT';
    return '';
}

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
    const aviso = document.createElement('div');
    aviso.id = 'xuper-fs-dialog';
    aviso.setAttribute('role', 'status');
    aviso.setAttribute('aria-live', 'polite');
    Object.assign(aviso.style, {
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
        display: 'none',
        zIndex: '2147483647',
    });

    document.body.appendChild(aviso);
    avisoFsDialog = aviso;
    return aviso;
}

function mostrarAvisoPantallaCompleta(texto, duracionMs = 2500) {
    const aviso = asegurarDialogPantallaCompleta();
    aviso.textContent = texto;
    aviso.style.display = 'block';

    clearTimeout(avisoFsTimer);
    avisoFsTimer = setTimeout(() => {
        if (aviso) {
            aviso.style.display = 'none';
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
        if (!estaEnPantallaCompleta() && avisoFsDialog) {
            avisoFsDialog.style.display = 'none';
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
        const escribiendoEnCampo = activo && (
            activo.tagName === 'INPUT' ||
            activo.tagName === 'TEXTAREA' ||
            activo.tagName === 'SELECT' ||
            activo.isContentEditable
        );

        if (!enFs && escribiendoEnCampo && !esFlechaVertical) {
            return;
        }
        if (!enFs && escribiendoEnCampo && esFlechaVertical && activo && activo.id === 'search-input') {
            return;
        }

        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') {
            e.stopImmediatePropagation();
        }

        liberarFocoPantallaCompleta();

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

function dispararInicioPrimerCanal() {
    if (!inicioAutomaticoPendiente || canalActivo || !canalesVisibles.length) return;
    const primerCanal = canalesVisibles.find(c => c && c.url) || canalesVisibles[0];
    if (!primerCanal || !primerCanal.url) return;

    inicioAutomaticoPendiente = false;
    reproducirCanal(primerCanal);
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
    dispararInicioPrimerCanal();
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
        quitar.appendChild(crearIconoTachoSvg());
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
   CUENTA DE USUARIO
   ===================================================================== */
const NOMBRES_PROVEEDOR = { google: 'Google', microsoft: 'Microsoft', github: 'GitHub', discord: 'Discord', local: 'local' };
const MENSAJES_LOGIN = {
    cancelado: 'inicio de sesión cancelado',
    error: 'no se pudo iniciar sesión · probá de nuevo',
    no_configurado: 'ese método de acceso todavía no está disponible',
};
let proveedoresCache = null;
let modoFormularioLogin = 'ingresar';

function apiFetch(url, opciones = {}) {
    return fetch(url, {
        credentials: 'same-origin',
        ...opciones,
        headers: { 'X-Requested-With': 'fetch', ...(opciones.headers || {}) },
    });
}

function configurarSesionUI() {
    el.btnLogin = document.getElementById('btn-login');
    el.userCard = document.getElementById('user-card');
    el.userAvatar = document.getElementById('user-avatar');
    el.userInicial = document.getElementById('user-inicial');
    el.userNombre = document.getElementById('user-nombre');
    el.userProveedor = document.getElementById('user-proveedor');
    el.btnSalir = document.getElementById('btn-salir');
    el.loginDialog = document.getElementById('login-dialog');
    el.loginProveedores = document.getElementById('login-proveedores');
    el.loginCerrar = document.getElementById('login-cerrar');
    el.loginTitulo = document.getElementById('login-titulo');
    el.tabIngresar = document.getElementById('tab-ingresar');
    el.tabRegistro = document.getElementById('tab-registro');
    el.loginForm = document.getElementById('login-form');
    el.loginEmail = document.getElementById('login-email');
    el.loginClave = document.getElementById('login-clave');
    el.btnVerClave = document.getElementById('btn-ver-clave');
    el.loginAyuda = document.getElementById('login-ayuda');
    el.loginError = document.getElementById('login-error');
    el.btnEnviar = document.getElementById('btn-enviar');

    if (el.btnLogin) el.btnLogin.addEventListener('click', abrirLogin);
    if (el.btnSalir) el.btnSalir.addEventListener('click', cerrarSesion);
    if (el.loginCerrar) el.loginCerrar.addEventListener('click', cerrarLogin);
    if (el.loginDialog) {
        el.loginDialog.addEventListener('click', (e) => {
            if (e.target === el.loginDialog) cerrarLogin();
        });
    }
    if (el.userAvatar) {
        el.userAvatar.addEventListener('error', () => {
            el.userAvatar.hidden = true;
            if (el.userInicial) el.userInicial.hidden = false;
        });
    }

    if (el.tabIngresar) {
        el.tabIngresar.addEventListener('click', () => cambiarModoLogin('ingresar'));
    }
    if (el.tabRegistro) {
        el.tabRegistro.addEventListener('click', () => cambiarModoLogin('registro'));
    }
    if (el.btnVerClave && el.loginClave) {
        el.btnVerClave.addEventListener('click', () => {
            const mostrar = el.loginClave.type === 'password';
            el.loginClave.type = mostrar ? 'text' : 'password';
            el.btnVerClave.setAttribute('aria-pressed', mostrar ? 'true' : 'false');
        });
    }
    if (el.loginForm) {
        el.loginForm.addEventListener('submit', manejarEnvioLoginLocal);
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && usuario &&
            Date.now() - ultimaSincronizacionFav > 30000) {
            cargarFavoritosServidor();
        }
    });

    manejarResultadoLoginEnURL();
}

function cambiarModoLogin(modo) {
    modoFormularioLogin = modo === 'registro' ? 'registro' : 'ingresar';
    const esRegistro = modoFormularioLogin === 'registro';

    if (el.loginTitulo) el.loginTitulo.textContent = esRegistro ? 'Crear cuenta' : 'Iniciar sesión';
    if (el.tabIngresar) {
        el.tabIngresar.classList.toggle('activa', !esRegistro);
        el.tabIngresar.setAttribute('aria-selected', !esRegistro ? 'true' : 'false');
    }
    if (el.tabRegistro) {
        el.tabRegistro.classList.toggle('activa', esRegistro);
        el.tabRegistro.setAttribute('aria-selected', esRegistro ? 'true' : 'false');
    }
    if (el.loginClave) {
        el.loginClave.setAttribute('autocomplete', esRegistro ? 'new-password' : 'current-password');
    }
    if (el.loginAyuda) el.loginAyuda.hidden = !esRegistro;
    if (el.btnEnviar) el.btnEnviar.textContent = esRegistro ? 'Crear cuenta' : 'Ingresar';
    ocultarErrorLogin();
}

function mostrarErrorLogin(texto) {
    if (!el.loginError) return;
    el.loginError.textContent = texto;
    el.loginError.hidden = false;
}

function ocultarErrorLogin() {
    if (!el.loginError) return;
    el.loginError.textContent = '';
    el.loginError.hidden = true;
}

async function enviarCredencialesLocales(email, clave, modo) {
    const rutas = modo === 'registro'
        ? [`${API_URL}/auth/registro`, `${API_URL}/auth/register`, `${API_URL}/auth/local/registro`]
        : [`${API_URL}/auth/login`, `${API_URL}/auth/local/login`, `${API_URL}/auth/ingresar`];

    let ultimoError = 'No se pudo iniciar sesión. Revisá tu email y contraseña.';

    for (const ruta of rutas) {
        try {
            const r = await apiFetch(ruta, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, clave, password: clave }),
            });

            if (r.status === 404) continue;

            let datos = null;
            try { datos = await r.json(); } catch (_) { datos = null; }

            if (!r.ok) {
                ultimoError = (datos && (datos.detail || datos.error || datos.mensaje)) || ultimoError;
                return { ok: false, error: typeof ultimoError === 'string' ? ultimoError : 'Credenciales inválidas.' };
            }
            return { ok: true, datos };
        } catch (_) {
            ultimoError = 'No se pudo conectar con el servidor.';
        }
    }
    return { ok: false, error: ultimoError };
}

async function manejarEnvioLoginLocal(e) {
    e.preventDefault();
    ocultarErrorLogin();

    const email = (el.loginEmail && el.loginEmail.value ? el.loginEmail.value : '').trim();
    const clave = el.loginClave && el.loginClave.value ? el.loginClave.value : '';

    if (!email || !clave) {
        mostrarErrorLogin('Completá tu email y contraseña.');
        return;
    }
    if (modoFormularioLogin === 'registro' && clave.length < 8) {
        mostrarErrorLogin('La contraseña debe tener al menos 8 caracteres.');
        return;
    }

    if (el.btnEnviar) el.btnEnviar.disabled = true;
    const res = await enviarCredencialesLocales(email, clave, modoFormularioLogin);
    if (el.btnEnviar) el.btnEnviar.disabled = false;

    if (!res.ok) {
        mostrarErrorLogin(res.error);
        return;
    }

    if (el.loginClave) el.loginClave.value = '';
    cerrarLogin();
    await cargarSesion();
    mostrarAvisoTransitorio('sesión iniciada');
}

function manejarResultadoLoginEnURL() {
    const params = new URLSearchParams(location.search);
    const resultado = params.get('login');
    const tieneQueryCredenciales = params.has('email') || params.has('clave');
    if (!resultado && !tieneQueryCredenciales) return;
    params.delete('login');
    params.delete('email');
    params.delete('clave');
    const resto = params.toString();
    history.replaceState(null, '', location.pathname + (resto ? `?${resto}` : '') + location.hash);
    if (MENSAJES_LOGIN[resultado]) mostrarAvisoTransitorio(MENSAJES_LOGIN[resultado], 4000);
}

async function cargarSesion() {
    try {
        const r = await apiFetch(`${API_URL}/auth/yo`);
        const datos = r.ok ? await r.json() : { usuario: null };
        usuario = datos.usuario || null;
    } catch (e) {
        usuario = null;
    }
    aplicarEstadoSesion();
    document.body.classList.add('sesion-lista');
    if (usuario) await cargarFavoritosServidor({ migrar: true });
}

function aplicarEstadoSesion() {
    document.body.classList.toggle('con-sesion', Boolean(usuario));
    if (el.btnLogin) el.btnLogin.hidden = Boolean(usuario);
    if (el.userCard) el.userCard.hidden = !usuario;

    if (usuario) {
        const nombre = usuario.nombre || 'Usuario';
        if (el.userNombre) el.userNombre.textContent = nombre;
        if (el.userProveedor) {
            el.userProveedor.textContent = `Cuenta de ${NOMBRES_PROVEEDOR[usuario.proveedor] || usuario.proveedor}`;
        }
        if (el.userInicial) {
            el.userInicial.textContent = nombre.trim().charAt(0).toUpperCase() || '?';
        }
        const tieneAvatar = Boolean(usuario.avatar);
        if (el.userAvatar) {
            el.userAvatar.hidden = !tieneAvatar;
            if (tieneAvatar) el.userAvatar.src = usuario.avatar;
        }
        if (el.userInicial) el.userInicial.hidden = tieneAvatar;
    } else {
        favoritos = [];
        modoRecorrido = 'principal';
        alternarPanelFavoritos(false);
    }
    renderizarFavoritos();
    actualizarBotonCorazon();
}

async function cargarFavoritosServidor({ migrar = false } = {}) {
    if (!usuario) return;
    try {
        const r = await apiFetch(`${API_URL}/favoritos`);
        if (r.status === 401) { sesionExpirada(); return; }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const datos = await r.json();
        favoritos = Array.isArray(datos.urls) ? datos.urls : [];

        const locales = migrar ? leerFavoritosLocales() : [];
        if (locales.length) {
            const r2 = await apiFetch(`${API_URL}/favoritos/importar`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ urls: locales }),
            });
            if (r2.ok) {
                const d2 = await r2.json();
                if (Array.isArray(d2.urls)) favoritos = d2.urls;
                try { localStorage.removeItem(STORAGE_FAVORITOS); } catch (e) { /* sin acceso */ }
            }
        }
        ultimaSincronizacionFav = Date.now();
    } catch (e) {
        console.warn('No se pudieron cargar los favoritos:', e);
    }
    renderizarFavoritos();
    actualizarBotonCorazon();
}

function sesionExpirada() {
    usuario = null;
    aplicarEstadoSesion();
    mostrarAvisoTransitorio('tu sesión expiró · iniciá sesión de nuevo', 4000);
}

async function cerrarSesion() {
    try {
        const r = await apiFetch(`${API_URL}/auth/salir`, { method: 'POST' });
        if (!r.ok && r.status !== 401) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
        mostrarAvisoTransitorio('no se pudo cerrar la sesión · probá de nuevo');
        return;
    }
    usuario = null;
    aplicarEstadoSesion();
    mostrarAvisoTransitorio('sesión cerrada');
}

/* ---------- Ventana de inicio de sesión ---------- */
function mostrarTextoLogin(texto) {
    if (!el.loginProveedores) return;
    el.loginProveedores.textContent = '';
    const p = document.createElement('p');
    p.className = 'login-vacio';
    p.textContent = texto;
    el.loginProveedores.appendChild(p);
}

async function abrirLogin() {
    if (!el.loginDialog) return;
    ocultarErrorLogin();
    if (!el.loginDialog.open) {
        if (typeof el.loginDialog.showModal === 'function') el.loginDialog.showModal();
        else el.loginDialog.setAttribute('open', '');
    }
    if (proveedoresCache === null) {
        mostrarTextoLogin('Cargando…');
        try {
            const r = await apiFetch(`${API_URL}/auth/proveedores`);
            const d = await r.json();
            proveedoresCache = Array.isArray(d.proveedores) ? d.proveedores : [];
        } catch (e) {
            mostrarTextoLogin('No se pudo conectar con el servidor. Probá de nuevo en un momento.');
            return;
        }
    }
    renderizarProveedores();
}

function cerrarLogin() {
    if (!el.loginDialog) return;
    if (typeof el.loginDialog.close === 'function') el.loginDialog.close();
    else el.loginDialog.removeAttribute('open');
}

function renderizarProveedores() {
    if (!el.loginProveedores) return;
    if (!proveedoresCache || !proveedoresCache.length) {
        mostrarTextoLogin('Todavía no hay métodos de acceso configurados en el servidor.');
        return;
    }
    el.loginProveedores.textContent = '';
    proveedoresCache.forEach(({ id, nombre }) => {
        const enlace = document.createElement('a');
        enlace.className = 'btn-prov';
        enlace.href = `/auth/login/${encodeURIComponent(id)}`;

        const icono = document.createElement('span');
        icono.className = 'btn-prov-icono';
        icono.textContent = '🔑';

        const texto = document.createElement('span');
        texto.textContent = `Continuar con ${nombre}`;

        enlace.appendChild(icono);
        enlace.appendChild(texto);
        el.loginProveedores.appendChild(enlace);
    });
}

/* =====================================================================
   FAVORITOS
   ===================================================================== */
function leerFavoritosLocales() {
    try {
        const datos = JSON.parse(leerPref(STORAGE_FAVORITOS) || '[]');
        return Array.isArray(datos) ? datos.filter(u => typeof u === 'string' && u.trim().length > 0) : [];
    } catch (e) {
        return [];
    }
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
    if (!usuario) {
        mostrarAvisoTransitorio('iniciá sesión para guardar favoritos');
        return;
    }
    if (!canal || !canal.url) {
        mostrarAvisoFavorito('Este canal no tiene una URL válida para guardar en favoritos.');
        return;
    }

    const url = canal.url;
    const i = favoritos.indexOf(url);
    const agregado = i === -1;
    if (agregado) favoritos.push(url);
    else favoritos.splice(i, 1);

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

    sincronizarFavorito(url, agregado);
}

async function sincronizarFavorito(url, agregado) {
    try {
        const r = agregado
            ? await apiFetch(`${API_URL}/favoritos`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url }),
            })
            : await apiFetch(`${API_URL}/favoritos?url=${encodeURIComponent(url)}`, { method: 'DELETE' });
        if (r.status === 401) { sesionExpirada(); return; }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
        const i = favoritos.indexOf(url);
        if (agregado && i !== -1) favoritos.splice(i, 1);
        if (!agregado && i === -1) favoritos.push(url);
        actualizarBotonCorazon();
        renderizarFavoritos();
        mostrarAvisoFavorito('No se pudo guardar el cambio. Revisá tu conexión e intentá de nuevo.');
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
    clearTimeout(timerInicioCanal);
    timerInicioCanal = null;
    detenerEsperaColchon();
    clearTimeout(player.timerReintento);
    clearTimeout(player.watchdog);
    clearTimeout(player.timerEstable);
    clearTimeout(player.timerSpinner);
    if (player.hls) {
        const hlsInst = player.hls;
        player.hls = null;
        try { hlsInst.stopLoad(); } catch (_) { /* ignorar */ }
        try { hlsInst.detachMedia(); } catch (_) { /* ignorar */ }
        try { hlsInst.destroy(); } catch (_) { /* ignorar */ }
    }
    player.modo = null;
    const v = el.video;
    if (v) {
        try { v.pause(); } catch (_) { /* ignorar */ }
        try { v.removeAttribute('src'); } catch (_) { /* ignorar */ }
    }
}

function reproducirCanal(canal, { automatico = false, manual = false } = {}) {
    if (!canal || !canal.url) return;
    limpiarMotor();
    inicioAutomaticoPendiente = false;
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

    const sesionActual = player.sesion;
    timerInicioCanal = setTimeout(() => {
        if (sesionActual === player.sesion && canalActivo && canalActivo.id === canal.id) {
            iniciarReproduccion();
        }
    }, 0);
}

function iniciarReproduccion() {
    const canal = canalActivo;
    if (!canal || !canal.url || !el.video) return;

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
            enableWorker: false,
            manifestLoadingTimeOut: 10000,
            manifestLoadingMaxRetry: 1,
            levelLoadingTimeOut: 10000,
            levelLoadingMaxRetry: 2,
            fragLoadingTimeOut: 15000,
            fragLoadingMaxRetry: 2,
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
        limpiarMotor();
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
    const canalRef = canalActivo;
    const intentoActual = player.intento;
    limpiarMotor();
    canalActivo = canalRef;
    player.intento = intentoActual;
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
    const sesionEsperada = player.sesion;
    mostrarOverlay('cargando', `Reconectando… intento ${player.intento} de ${MAX_REINTENTOS}`);
    player.timerReintento = setTimeout(() => {
        if (sesionEsperada === player.sesion && canalActivo && canalActivo.id === canalRef.id) {
            iniciarReproduccion();
        }
    }, espera);
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
