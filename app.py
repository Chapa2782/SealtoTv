"""Sealto TV - backend.

Novedades de esta versión:
  * Prevención estricta de duplicados al importar listas M3U (por URL normalizada y por nombre normalizado).
  * Detección automática de idioma según metadatos, nombre del canal, tvg-id y URL de lista.
  * Cada canal tiene un estado: 'ok', 'caido' o 'desconocido'.
  * Verificación masiva en segundo plano (con progreso y cancelación).
  * Verificación individual cuando el reproductor falla (con cooldown).
  * Verificación automática opcional cada N horas (AUTO_VERIFICAR_HORAS).
  * Migración automática de la base de datos existente (no pierde canales).
  * Protección SSRF al descargar listas y al verificar canales.

Variables de entorno opcionales:
  AUTO_VERIFICAR_HORAS   (default 0 = desactivado)
  WORKERS_CHEQUEO        (default 20, chequeos en paralelo)
  TIMEOUT_CHEQUEO        (default 8, segundos por petición)
  PERMITIR_IPS_PRIVADAS  (default 0; poné 1 si tus streams están en tu red local)

Ejecutar con UN solo worker (el estado del chequeo vive en memoria):
  uvicorn app:app --host 0.0.0.0 --port 8000
"""
import ipaddress
import os
import re
import socket
import sqlite3
import ssl
import threading
import time
import unicodedata
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import urljoin, urlparse, urlunparse

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

app = FastAPI(title="Sealto TV Backend", version="1.5")

# --- RUTAS Y CONFIGURACIÓN ---
BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "streaming.db"

TIMEOUT_CHEQUEO = float(os.environ.get("TIMEOUT_CHEQUEO", "8"))
WORKERS_CHEQUEO = int(os.environ.get("WORKERS_CHEQUEO", "20"))
AUTO_VERIFICAR_HORAS = float(os.environ.get("AUTO_VERIFICAR_HORAS", "0"))
PERMITIR_PRIVADAS = os.environ.get("PERMITIR_IPS_PRIVADAS", "0") == "1"

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
MAX_LISTA_BYTES = 30 * 1024 * 1024   # tope de descarga de una lista M3U
MAX_MANIFIESTO = 256 * 1024          # tope al leer un manifiesto HLS
COOLDOWN_INDIVIDUAL = 30             # segundos entre verificaciones del mismo canal

app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")

# El front se sirve desde este mismo servidor, no hace falta enviar credenciales.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# =====================================================================
# NORMALIZACIÓN Y ANTI-DUPLICADOS
# =====================================================================
def normalizar_url(url: str) -> str:
    """Normaliza una URL para detectar duplicados aunque tenga espacios,
    mayúsculas en el host o barra final redundante en la raíz."""
    limpia = (url or "").strip()
    if not limpia:
        return ""
    try:
        p = urlparse(limpia)
        esquema = (p.scheme or "").lower()
        host = (p.hostname or "").lower()
        puerto = f":{p.port}" if p.port else ""
        netloc = f"{host}{puerto}" if host else p.netloc.lower()
        ruta = p.path or "/"
        if ruta != "/" and ruta.endswith("/"):
            ruta = ruta.rstrip("/")
        return urlunparse((esquema, netloc, ruta, p.params, p.query, ""))
    except ValueError:
        return limpia.lower().rstrip("/")


def normalizar_nombre_canal(nombre: str) -> str:
    """Normaliza el nombre del canal quitando tildes, etiquetas de resolución/calidad
    y caracteres especiales para evitar duplicados equivalentes."""
    sin_tildes = unicodedata.normalize("NFD", nombre or "")
    sin_acentos = "".join(ch for ch in sin_tildes if unicodedata.category(ch) != "Mn").lower()
    sin_calidad = re.sub(
        r"\b(hd|fhd|uhd|sd|4k|1080p?|720p?|480p?|not\s*24/?7|24/?7)\b",
        " ",
        sin_acentos,
    )
    return re.sub(r"[^a-z0-9]", "", sin_calidad)


# =====================================================================
# BASE DE DATOS
# =====================================================================
@contextmanager
def get_db():
    """Abre una conexión, hace commit al salir y siempre la cierra."""
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    with get_db() as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("""
            CREATE TABLE IF NOT EXISTS canales (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nombre TEXT,
                categoria TEXT,
                idioma TEXT,
                url TEXT UNIQUE,
                logo TEXT
            )
        """)
        # Migración: agrega las columnas nuevas si la tabla ya existía.
        existentes = {r["name"] for r in db.execute("PRAGMA table_info(canales)")}
        nuevas = {
            "estado": "TEXT NOT NULL DEFAULT 'desconocido'",
            "ultima_revision": "TEXT",
            "fallos": "INTEGER NOT NULL DEFAULT 0",
            "latencia_ms": "INTEGER",
        }
        for columna, definicion in nuevas.items():
            if columna not in existentes:
                db.execute(f"ALTER TABLE canales ADD COLUMN {columna} {definicion}")

        # Limpia duplicados exactos de URL si existieran antes de crear el índice único.
        db.execute("""
            DELETE FROM canales
            WHERE id NOT IN (
                SELECT MIN(id) FROM canales GROUP BY LOWER(TRIM(url))
            )
        """)
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_canales_url_unica ON canales(LOWER(TRIM(url)))")
        db.execute("CREATE INDEX IF NOT EXISTS idx_canales_estado ON canales(estado)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_canales_nombre ON canales(nombre)")


init_db()


def _ahora() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# =====================================================================
# RED SEGURA (anti-SSRF)
# =====================================================================
def url_es_segura(url: str) -> bool:
    """Solo http/https y, salvo que lo permitas, nunca hacia IPs internas."""
    limpia = (url or "").strip()
    try:
        p = urlparse(limpia)
        if p.scheme not in ("http", "https") or not p.hostname:
            return False
        if PERMITIR_PRIVADAS:
            return True
        puerto = p.port or (443 if p.scheme == "https" else 80)
        for info in socket.getaddrinfo(p.hostname, puerto, proto=socket.IPPROTO_TCP):
            ip = ipaddress.ip_address(info[4][0])
            if (ip.is_private or ip.is_loopback or ip.is_link_local
                    or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
                return False
        return True
    except (ValueError, OSError):
        try:
            p = urlparse(limpia)
            return p.scheme in ("http", "https") and bool(p.hostname)
        except ValueError:
            return False


class _RedirigirSeguro(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        abs_url = urljoin(req.full_url, newurl)
        if not url_es_segura(abs_url):
            raise urllib.error.URLError("Redirección a un destino no permitido")
        return super().redirect_request(req, fp, code, msg, headers, abs_url)


_ctx_ssl = ssl.create_default_context()
_opener = urllib.request.build_opener(
    _RedirigirSeguro,
    urllib.request.HTTPSHandler(context=_ctx_ssl),
)


def _abrir(url: str, timeout: float):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    try:
        return _opener.open(req, timeout=timeout)
    except urllib.error.URLError as exc:
        if "CERTIFICATE_VERIFY_FAILED" in str(exc):
            ctx_libre = ssl._create_unverified_context()
            opener_libre = urllib.request.build_opener(
                _RedirigirSeguro,
                urllib.request.HTTPSHandler(context=ctx_libre),
            )
            return opener_libre.open(req, timeout=timeout)
        raise


# =====================================================================
# VERIFICACIÓN DE CANALES
# =====================================================================
def _limpiar_inicio(texto: str) -> str:
    return texto.lstrip("\ufeff \t\r\n")


def _hls_responde(base: str, texto: str, nivel: int = 0) -> bool:
    """Valida una playlist HLS: si es master baja a la primera variante y
    después comprueba que el último segmento realmente se pueda leer."""
    es_master = "#EXT-X-STREAM-INF" in texto
    uris = [l.strip() for l in texto.splitlines() if l.strip() and not l.strip().startswith("#")]
    if not uris:
        return False
    destino = urljoin(base, uris[0] if es_master else uris[-1])
    if not url_es_segura(destino):
        return False
    with _abrir(destino, TIMEOUT_CHEQUEO) as r:
        if es_master:
            if nivel >= 2:
                return False
            cuerpo = _limpiar_inicio(r.read(MAX_MANIFIESTO).decode("utf-8", "ignore"))
            if not cuerpo.startswith("#EXTM3U"):
                return False
            return _hls_responde(destino, cuerpo, nivel + 1)
        return len(r.read(1)) == 1


def _comprobar_una_vez(url: str):
    """Devuelve (ok, latencia_ms)."""
    inicio = time.monotonic()
    try:
        with _abrir(url, TIMEOUT_CHEQUEO) as resp:
            primeros = resp.read(2048)
            latencia = int((time.monotonic() - inicio) * 1000)
            if not primeros:
                return False, None
            cabecera = _limpiar_inicio(primeros.decode("utf-8", "ignore"))
            if cabecera.startswith("#EXTM3U"):
                resto = resp.read(MAX_MANIFIESTO)
                texto = _limpiar_inicio((primeros + resto).decode("utf-8", "ignore"))
                return (True, latencia) if _hls_responde(url, texto) else (False, None)
            # Stream directo: descartamos páginas de error que devuelven 200.
            muestra = cabecera[:300].lower()
            if muestra.startswith("<!doctype html") or "<html" in muestra:
                return False, None
            return True, latencia
    except Exception:
        return False, None


def comprobar_canal(url: str, intentos: int = 2):
    """Reintenta para no marcar como caído un canal por un fallo momentáneo."""
    if not url_es_segura(url):
        return False, None
    for n in range(intentos):
        ok, latencia = _comprobar_una_vez(url)
        if ok:
            return True, latencia
        if n < intentos - 1:
            time.sleep(1.0)
    return False, None


def _guardar_resultado(db, canal_id: int, ok: bool, latencia: Optional[int]):
    if ok:
        db.execute(
            "UPDATE canales SET estado='ok', fallos=0, latencia_ms=?, ultima_revision=? WHERE id=?",
            (latencia, _ahora(), canal_id),
        )
    else:
        db.execute(
            "UPDATE canales SET estado='caido', fallos=fallos+1, latencia_ms=NULL, ultima_revision=? WHERE id=?",
            (_ahora(), canal_id),
        )


# --- Trabajo masivo en segundo plano ---------------------------------
_job_lock = threading.Lock()
_job = {
    "activo": False, "cancelar": False, "cancelado": False, "modo": None,
    "total": 0, "hechos": 0, "ok": 0, "caidos": 0, "inicio": None, "fin": None,
}


def _ejecutar_verificacion(modo: str):
    try:
        sql = "SELECT id, url FROM canales"
        if modo == "pendientes":
            sql += " WHERE estado = 'desconocido'"
        elif modo == "problemas":
            sql += " WHERE estado = 'caido'"
        with get_db() as db:
            filas = [(r["id"], r["url"]) for r in db.execute(sql)]
        with _job_lock:
            _job["total"] = len(filas)

        with ThreadPoolExecutor(max_workers=WORKERS_CHEQUEO) as pool, get_db() as db:
            futuros = {pool.submit(comprobar_canal, url): cid for cid, url in filas}
            for i, fut in enumerate(as_completed(futuros), 1):
                with _job_lock:
                    cancelar = _job["cancelar"]
                if cancelar:
                    for f in futuros:
                        f.cancel()
                    with _job_lock:
                        _job["cancelado"] = True
                    break
                cid = futuros[fut]
                try:
                    ok, latencia = fut.result()
                except Exception:
                    ok, latencia = False, None
                _guardar_resultado(db, cid, ok, latencia)
                if i % 25 == 0:
                    db.commit()
                with _job_lock:
                    _job["hechos"] += 1
                    _job["ok" if ok else "caidos"] += 1
    finally:
        with _job_lock:
            _job["activo"] = False
            _job["fin"] = _ahora()


def _iniciar_job(modo: str) -> bool:
    with _job_lock:
        if _job["activo"]:
            return False
        _job.update(
            activo=True, cancelar=False, cancelado=False, modo=modo,
            total=0, hechos=0, ok=0, caidos=0, inicio=_ahora(), fin=None,
        )
    threading.Thread(target=_ejecutar_verificacion, args=(modo,), daemon=True).start()
    return True


def _bucle_auto():
    while True:
        time.sleep(AUTO_VERIFICAR_HORAS * 3600)
        _iniciar_job("todos")


@app.on_event("startup")
def _al_iniciar():
    if AUTO_VERIFICAR_HORAS > 0:
        threading.Thread(target=_bucle_auto, daemon=True).start()


# =====================================================================
# PÁGINAS
# =====================================================================
@app.get("/admin.html", response_class=HTMLResponse)
async def admin_page():
    return (BASE_DIR / "admin.html").read_text(encoding="utf-8")


@app.get("/", response_class=HTMLResponse)
async def read_root():
    """Sirve automáticamente el archivo index.html principal de la aplicación."""
    index_path = BASE_DIR / "index.html"
    if index_path.exists():
        return index_path.read_text(encoding="utf-8")
    raise HTTPException(
        status_code=404,
        detail="No se encontró el archivo index.html en la carpeta del servidor.",
    )


# =====================================================================
# IMPORTACIÓN M3U (SIN DUPLICADOS + DETECCIÓN DE IDIOMA)
# =====================================================================
class M3UImportRequest(BaseModel):
    url: str


_CODIGOS_A_IDIOMA = {
    "spa": "Español",
    "esp": "Español",
    "spanish": "Español",
    "castellano": "Español",
    "es": "Español",
    "ar": "Español",
    "mx": "Español",
    "cl": "Español",
    "co": "Español",
    "uy": "Español",
    "pe": "Español",
    "ve": "Español",
    "ec": "Español",
    "bo": "Español",
    "py": "Español",
    "cr": "Español",
    "pa": "Español",
    "do": "Español",
    "gt": "Español",
    "hn": "Español",
    "ni": "Español",
    "sv": "Español",
    "eng": "Inglés",
    "english": "Inglés",
    "en": "Inglés",
    "us": "Inglés",
    "uk": "Inglés",
    "gb": "Inglés",
    "ca": "Inglés",
    "au": "Inglés",
    "por": "Portugués",
    "portuguese": "Portugués",
    "pt": "Portugués",
    "br": "Portugués",
    "fra": "Francés",
    "fre": "Francés",
    "french": "Francés",
    "fr": "Francés",
    "deu": "Alemán",
    "ger": "Alemán",
    "german": "Alemán",
    "de": "Alemán",
    "ita": "Italiano",
    "italian": "Italiano",
    "it": "Italiano",
    "ara": "Árabe",
    "arabic": "Árabe",
    "rus": "Ruso",
    "russian": "Ruso",
    "jpn": "Japonés",
    "japanese": "Japonés",
    "zho": "Chino",
    "chi": "Chino",
    "chinese": "Chino",
}

_PALABRAS_IDIOMA = [
    (r"\b(english|eng)\b", "Inglés"),
    (r"\b(spanish|espanol|español|castellano|spa)\b", "Español"),
    (r"\b(portuguese|portugues|português|por)\b", "Portugués"),
    (r"\b(french|frances|francés|fra)\b", "Francés"),
    (r"\b(german|aleman|alemán|deu)\b", "Alemán"),
    (r"\b(italian|italiano|ita)\b", "Italiano"),
    (r"\b(arabic|arabe|árabe|ara)\b", "Árabe"),
    (r"\b(russian|ruso|rus)\b", "Ruso"),
    (r"\b(japanese|japones|japonés|jpn|anime)\b", "Japonés"),
]


def detectar_idioma(linea_extinf: str, nombre: str, url_lista: str) -> str:
    match_lang = re.search(r'tvg-language="([^"]+)"', linea_extinf, re.IGNORECASE)
    if match_lang:
        raw = match_lang.group(1).strip().lower()
        if raw in _CODIGOS_A_IDIOMA:
            return _CODIGOS_A_IDIOMA[raw]
        for codigo, etiqueta in _CODIGOS_A_IDIOMA.items():
            if re.search(rf"\b{re.escape(codigo)}\b", raw):
                return etiqueta
        if raw:
            return raw.capitalize()

    url_low = (url_lista or "").lower()
    m_url_lang = re.search(r"/languages/([a-z]{2,3})\.m3u", url_low)
    if m_url_lang:
        cod = m_url_lang.group(1)
        if cod in _CODIGOS_A_IDIOMA:
            return _CODIGOS_A_IDIOMA[cod]

    m_url_country = re.search(r"/countries/([a-z]{2,3})\.m3u", url_low)
    if m_url_country:
        cod = m_url_country.group(1)
        if cod in _CODIGOS_A_IDIOMA:
            return _CODIGOS_A_IDIOMA[cod]

    texto_nombre = (nombre or "").lower()
    for patron, etiqueta in _PALABRAS_IDIOMA:
        if re.search(patron, texto_nombre):
            return etiqueta

    match_id = re.search(r'tvg-id="[^"@]*\.([a-z]{2,3})(?:@[^"]*)?"', linea_extinf, re.IGNORECASE)
    if match_id:
        cod = match_id.group(1).lower()
        if cod in _CODIGOS_A_IDIOMA:
            return _CODIGOS_A_IDIOMA[cod]

    if any(p in url_low for p in ("/spa.m3u", "/ar.m3u", "/mex.m3u", "/es.m3u", "/uy.m3u", "/cl.m3u", "/co.m3u", "/pe.m3u")):
        return "Español"

    return "Otro"


def _atributo(linea: str, nombre_attr: str) -> str:
    m = re.search(r'%s="([^"]*)"' % re.escape(nombre_attr), linea, re.IGNORECASE)
    return m.group(1).strip() if m else ""


def _nombre_extinf(linea: str) -> str:
    """El nombre va después de la última coma que sigue a los atributos."""
    ultima_comilla = linea.rfind('"')
    coma = linea.find(",", ultima_comilla + 1 if ultima_comilla != -1 else 0)
    nombre = linea[coma + 1:].strip() if coma != -1 else ""
    return nombre or "Canal sin nombre"


def _limpiar_url_entrada(raw_url: str) -> str:
    """Limpia URLs pegadas con formato Markdown [a](b) o paréntesis/corchetes pegados."""
    texto = (raw_url or "").strip()
    m_md = re.search(r"\]\((https?://[^\s\)\]]+)\)", texto, re.IGNORECASE)
    if m_md:
        return m_md.group(1).strip()
    m_url = re.search(r"https?://[^\s\]\)\"\'<>]+", texto, re.IGNORECASE)
    if m_url:
        return m_url.group(0).strip()
    return texto


@app.post("/api/importar")
def importar_m3u(datos: M3UImportRequest):
    url = _limpiar_url_entrada(datos.url)
    if not url:
        print("[IMPORTAR 400] URL vacía")
        raise HTTPException(status_code=400, detail="URL no proporcionada")
    if not url_es_segura(url):
        print(f"[IMPORTAR 400] URL no permitida: {url}")
        raise HTTPException(status_code=400, detail="URL no permitida (solo http/https públicas).")

    try:
        with _abrir(url, 20) as response:
            crudo = response.read(MAX_LISTA_BYTES + 1)
        if len(crudo) > MAX_LISTA_BYTES:
            print(f"[IMPORTAR 400] Lista supera 30 MB: {url}")
            raise HTTPException(status_code=400, detail="La lista supera el tamaño máximo permitido (30 MB).")
        contenido = crudo.decode("utf-8", errors="ignore")
    except HTTPException:
        raise
    except Exception as e:
        print(f"[IMPORTAR 400] Falló descarga de {url} -> {type(e).__name__}: {e}")
        raise HTTPException(status_code=400, detail=f"No se pudo descargar la lista: {str(e)}")

    lineas = contenido.splitlines()
    if len(lineas) < 2 or not any(l.strip().startswith(("#EXTINF:", "#EXTM3U")) for l in lineas[:15]):
        print(f"[IMPORTAR 400] Contenido inválido en {url}: {lineas[:3]}")
        raise HTTPException(status_code=400, detail="El archivo descargado está vacío o no es una lista M3U válida.")

    importados = omitidos = descartados = 0
    nombre_actual = None
    categoria_actual = "General"
    logo_actual = ""
    extinf_actual = ""

    with get_db() as db:
        urls_existentes = set()
        nombres_existentes = set()
        for fila in db.execute("SELECT nombre, url FROM canales"):
            u_norm = normalizar_url(fila["url"])
            if u_norm:
                urls_existentes.add(u_norm)
            n_norm = normalizar_nombre_canal(fila["nombre"])
            if n_norm:
                nombres_existentes.add(n_norm)

        for linea in lineas:
            linea = linea.strip()
            if linea.startswith("#EXTINF:"):
                extinf_actual = linea
                nombre_actual = _nombre_extinf(linea)
                categoria_actual = _atributo(linea, "group-title") or "General"
                logo_actual = _atributo(linea, "tvg-logo")
            elif linea and not linea.startswith("#"):
                if nombre_actual:
                    url_limpia = linea.strip()
                    if not url_limpia.lower().startswith(("http://", "https://")):
                        descartados += 1
                    else:
                        u_norm = normalizar_url(url_limpia)
                        n_norm = normalizar_nombre_canal(nombre_actual)

                        if (u_norm and u_norm in urls_existentes) or (n_norm and n_norm in nombres_existentes):
                            omitidos += 1
                        else:
                            idioma = detectar_idioma(extinf_actual, nombre_actual, url)
                            cur = db.execute(
                                "INSERT OR IGNORE INTO canales (nombre, categoria, idioma, url, logo) "
                                "VALUES (?, ?, ?, ?, ?)",
                                (nombre_actual, categoria_actual, idioma, url_limpia, logo_actual),
                            )
                            if cur.rowcount == 1:
                                importados += 1
                                if u_norm:
                                    urls_existentes.add(u_norm)
                                if n_norm:
                                    nombres_existentes.add(n_norm)
                            else:
                                omitidos += 1
                nombre_actual = None
                logo_actual = ""
                extinf_actual = ""

    return {"status": "success", "importados": importados, "omitidos": omitidos, "descartados": descartados}


# =====================================================================
# API PÚBLICA
# =====================================================================
@app.get("/api/canales")
def obtener_canales(
    categoria: Optional[str] = None,
    idioma: Optional[str] = None,
    estado: Optional[str] = None,
    ocultar_caidos: bool = False,
):
    sql = ("SELECT id, nombre, categoria, idioma, url, logo, estado, ultima_revision "
           "FROM canales WHERE 1=1")
    params = []

    if categoria and categoria not in ("Todas", "TV"):
        sql += " AND categoria = ?"
        params.append(categoria)
    if idioma and idioma != "Todos":
        sql += " AND idioma = ?"
        params.append(idioma)
    if estado in ("ok", "caido", "desconocido"):
        sql += " AND estado = ?"
        params.append(estado)
    if ocultar_caidos:
        sql += " AND estado != 'caido'"

    sql += " ORDER BY id"
    with get_db() as db:
        return [dict(r) for r in db.execute(sql, params)]


@app.get("/api/categorias")
def obtener_categorias(idioma: Optional[str] = None):
    with get_db() as db:
        filas = db.execute("SELECT DISTINCT categoria FROM canales").fetchall()

    categorias_limpias = set()
    for f in filas:
        if not f[0]:
            continue
        cat_principal = f[0].split(";")[0].strip().upper()
        if 0 < len(cat_principal) <= 25:
            categorias_limpias.add(cat_principal)
    return sorted(categorias_limpias)


# Verificación individual (la dispara el reproductor cuando un canal falla)
_ultimo_chequeo = {}
_sem_individual = threading.BoundedSemaphore(8)


@app.post("/api/canales/{canal_id}/verificar")
def verificar_canal(canal_id: int):
    with get_db() as db:
        fila = db.execute("SELECT id, url, estado FROM canales WHERE id = ?", (canal_id,)).fetchone()
    if not fila:
        raise HTTPException(status_code=404, detail="Canal no encontrado")

    ahora = time.time()
    if ahora - _ultimo_chequeo.get(canal_id, 0) < COOLDOWN_INDIVIDUAL:
        return {"id": canal_id, "estado": fila["estado"], "cacheado": True}

    if not _sem_individual.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="Demasiadas verificaciones en curso, probá en unos segundos.")
    try:
        if len(_ultimo_chequeo) > 5000:
            _ultimo_chequeo.clear()
        _ultimo_chequeo[canal_id] = ahora
        ok, latencia = comprobar_canal(fila["url"], intentos=1)
    finally:
        _sem_individual.release()

    with get_db() as db:
        _guardar_resultado(db, canal_id, ok, latencia)
    return {"id": canal_id, "estado": "ok" if ok else "caido", "cacheado": False}


# =====================================================================
# API ADMIN
# =====================================================================
@app.get("/api/admin/stats")
def obtener_estadisticas():
    conteo = {"ok": 0, "caido": 0, "desconocido": 0}
    with get_db() as db:
        for r in db.execute("SELECT estado, COUNT(*) AS c FROM canales GROUP BY estado"):
            conteo[r["estado"] if r["estado"] in conteo else "desconocido"] += r["c"]
    return {
        "total_canales": sum(conteo.values()),
        "ok": conteo["ok"],
        "caidos": conteo["caido"],
        "desconocidos": conteo["desconocido"],
    }


@app.get("/api/admin/canales")
def listar_canales_admin(q: Optional[str] = None, estado: Optional[str] = None, limit: int = 300):
    """Devuelve los canales (id, nombre, estado) para gestionarlos o eliminarlos."""
    where, params = [], []
    if q and q.strip():
        where.append("nombre LIKE ?")
        params.append(f"%{q.strip()}%")
    if estado in ("ok", "caido", "desconocido"):
        where.append("estado = ?")
        params.append(estado)
    clausula = (" WHERE " + " AND ".join(where)) if where else ""
    limit = max(1, min(limit, 1000))

    with get_db() as db:
        total = db.execute(f"SELECT COUNT(*) FROM canales{clausula}", params).fetchone()[0]
        filas = db.execute(
            f"SELECT id, nombre, estado, ultima_revision FROM canales{clausula} "
            f"ORDER BY nombre COLLATE NOCASE LIMIT ?",
            params + [limit],
        ).fetchall()
    return {"total": total, "items": [dict(f) for f in filas]}


@app.delete("/api/admin/canales/{canal_id}")
def eliminar_canal_admin(canal_id: int):
    with get_db() as db:
        eliminados = db.execute("DELETE FROM canales WHERE id = ?", (canal_id,)).rowcount
    if eliminados == 0:
        raise HTTPException(status_code=404, detail="Canal no encontrado")
    return {"status": "success", "eliminado_id": canal_id}


@app.delete("/api/admin/caidos")
def eliminar_caidos():
    with get_db() as db:
        eliminados = db.execute("DELETE FROM canales WHERE estado = 'caido'").rowcount
    return {"status": "success", "eliminados": eliminados}


@app.delete("/api/admin/limpiar")
def limpiar_base_datos():
    with get_db() as db:
        db.execute("DELETE FROM canales")
    return {"status": "success", "message": "Base de datos vaciada correctamente"}


@app.post("/api/admin/verificar")
def iniciar_verificacion(modo: str = "todos"):
    """modo: 'todos' | 'pendientes' (sin verificar) | 'problemas' (re-chequear caídos)."""
    if modo not in ("todos", "pendientes", "problemas"):
        raise HTTPException(status_code=400, detail="Modo inválido")
    if not _iniciar_job(modo):
        raise HTTPException(status_code=409, detail="Ya hay una verificación en curso")
    return {"status": "iniciado", "modo": modo}


@app.get("/api/admin/verificar/estado")
def estado_verificacion():
    with _job_lock:
        return dict(_job)


@app.post("/api/admin/verificar/cancelar")
def cancelar_verificacion():
    with _job_lock:
        if not _job["activo"]:
            raise HTTPException(status_code=409, detail="No hay verificación en curso")
        _job["cancelar"] = True
    return {"status": "cancelando"}