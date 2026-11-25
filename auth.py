"""Sealto TV - login de usuarios (OAuth 2.0) y favoritos por cuenta.

Sin dependencias extra: usa solo la librería estándar + FastAPI.

Proveedores soportados (cada uno se activa solo si cargás sus credenciales):
    GOOGLE_CLIENT_ID      / GOOGLE_CLIENT_SECRET
    MICROSOFT_CLIENT_ID   / MICROSOFT_CLIENT_SECRET   (opcional: MICROSOFT_TENANT, default "common")
    GITHUB_CLIENT_ID      / GITHUB_CLIENT_SECRET
    DISCORD_CLIENT_ID     / DISCORD_CLIENT_SECRET

Otras variables opcionales:
    BASE_URL   Dirección pública del sitio (ej. https://sealto.tv). Si no se define se usa
               la dirección con la que el navegador abrió la página.

URI de redireccion que hay que registrar en cada proveedor:
    {BASE_URL}/auth/callback/google   (y /microsoft, /github, /discord)

Seguridad:
  * Sesión en el servidor (tabla `sesiones`); el navegador solo guarda un token aleatorio en una
    cookie HttpOnly + SameSite=Lax (+ Secure cuando el sitio va por HTTPS). El token se guarda
    hasheado en la base.
  * Parámetro `state` para evitar falsificación del inicio de sesión.
  * Las operaciones que modifican datos exigen la cabecera X-Requested-With (anti-CSRF).
  * No se vinculan cuentas de distintos proveedores por email (el email puede no estar verificado).
"""
import hashlib
import json
import os
import secrets
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "streaming.db"

COOKIE_SESION = "sealto_sesion"
COOKIE_STATE = "sealto_oauth_state"
SESION_DIAS = 30
MAX_FAVORITOS = 1000
USER_AGENT = "SealtoTV/1.0 (login)"

router = APIRouter()


# =====================================================================
# BASE DE DATOS
# =====================================================================
@contextmanager
def _db():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _ahora() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def init_auth_db():
    with _db() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS usuarios (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                proveedor TEXT NOT NULL,
                proveedor_id TEXT NOT NULL,
                nombre TEXT,
                email TEXT,
                avatar TEXT,
                creado TEXT NOT NULL,
                ultimo_acceso TEXT NOT NULL,
                UNIQUE (proveedor, proveedor_id)
            )
        """)
        db.execute("""
            CREATE TABLE IF NOT EXISTS sesiones (
                token_hash TEXT PRIMARY KEY,
                usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
                creada TEXT NOT NULL,
                expira TEXT NOT NULL
            )
        """)
        db.execute("CREATE INDEX IF NOT EXISTS idx_sesiones_usuario ON sesiones(usuario_id)")
        db.execute("""
            CREATE TABLE IF NOT EXISTS favoritos (
                usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
                url TEXT NOT NULL,
                creado TEXT NOT NULL,
                PRIMARY KEY (usuario_id, url)
            )
        """)


# =====================================================================
# PROVEEDORES OAUTH
# =====================================================================
def _norm_google(d: dict) -> dict:
    verificado = d.get("email_verified", True)
    return {
        "id": str(d.get("sub", "")),
        "nombre": d.get("name") or d.get("given_name") or "",
        "email": (d.get("email") or "") if verificado else "",
        "avatar": d.get("picture") or "",
    }


def _norm_microsoft(d: dict) -> dict:
    return {
        "id": str(d.get("sub", "")),
        "nombre": d.get("name") or "",
        "email": d.get("email") or "",
        "avatar": "",  # la foto de Microsoft requiere otra llamada autenticada
    }


def _norm_github(d: dict) -> dict:
    return {
        "id": str(d.get("id", "")),
        "nombre": d.get("name") or d.get("login") or "",
        "email": d.get("email") or "",
        "avatar": d.get("avatar_url") or "",
    }


def _norm_discord(d: dict) -> dict:
    uid, hash_avatar = str(d.get("id", "")), d.get("avatar")
    avatar = f"https://cdn.discordapp.com/avatars/{uid}/{hash_avatar}.png?size=128" if uid and hash_avatar else ""
    return {
        "id": uid,
        "nombre": d.get("global_name") or d.get("username") or "",
        "email": "",
        "avatar": avatar,
    }


PROVEEDORES = {
    "google": {
        "nombre": "Google",
        "autorizar": "https://accounts.google.com/o/oauth2/v2/auth",
        "token": "https://oauth2.googleapis.com/token",
        "perfil": "https://openidconnect.googleapis.com/v1/userinfo",
        "scope": "openid email profile",
        "extra": {"prompt": "select_account"},
        "normalizar": _norm_google,
    },
    "microsoft": {
        "nombre": "Microsoft",
        "autorizar": "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize",
        "token": "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
        "perfil": "https://graph.microsoft.com/oidc/userinfo",
        "scope": "openid profile email",
        "extra": {"prompt": "select_account"},
        "normalizar": _norm_microsoft,
    },
    "github": {
        "nombre": "GitHub",
        "autorizar": "https://github.com/login/oauth/authorize",
        "token": "https://github.com/login/oauth/access_token",
        "perfil": "https://api.github.com/user",
        "scope": "read:user",
        "extra": {},
        "normalizar": _norm_github,
    },
    "discord": {
        "nombre": "Discord",
        "autorizar": "https://discord.com/oauth2/authorize",
        "token": "https://discord.com/api/oauth2/token",
        "perfil": "https://discord.com/api/users/@me",
        "scope": "identify",
        "extra": {"prompt": "none"},
        "normalizar": _norm_discord,
    },
}


def _credenciales(clave: str):
    prefijo = clave.upper()
    cid = os.environ.get(f"{prefijo}_CLIENT_ID", "").strip()
    secreto = os.environ.get(f"{prefijo}_CLIENT_SECRET", "").strip()
    return (cid, secreto) if cid and secreto else None


def proveedores_activos() -> List[str]:
    return [k for k in PROVEEDORES if _credenciales(k)]


def _url(cfg: dict, campo: str) -> str:
    tenant = os.environ.get("MICROSOFT_TENANT", "common").strip() or "common"
    return cfg[campo].format(tenant=tenant) if "{tenant}" in cfg[campo] else cfg[campo]


def descripcion_config() -> List[str]:
    """Líneas para mostrar al arrancar el servidor."""
    base = os.environ.get("BASE_URL", "").strip().rstrip("/") or "http://127.0.0.1:8000"
    activos = proveedores_activos()
    if not activos:
        return ["[login] Ningún proveedor configurado: la página funciona, pero nadie podrá iniciar sesión."]
    return [f"[login] {PROVEEDORES[k]['nombre']} activo -> URI de redirección: {base}/auth/callback/{k}"
            for k in activos]


def _http_json(url: str, datos: Optional[dict] = None, cabeceras: Optional[dict] = None, timeout: float = 15):
    """Llamada a las URLs fijas de los proveedores (no recibe direcciones del usuario)."""
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    headers.update(cabeceras or {})
    cuerpo = None
    if datos is not None:
        cuerpo = urllib.parse.urlencode(datos).encode("utf-8")
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=cuerpo, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        crudo = resp.read(1024 * 1024)
    return json.loads(crudo.decode("utf-8"))


# =====================================================================
# UTILIDADES DE REQUEST / SESIÓN
# =====================================================================
def _es_https(request: Request) -> bool:
    if os.environ.get("BASE_URL", "").strip().lower().startswith("https://"):
        return True
    return request.headers.get("x-forwarded-proto", request.url.scheme) == "https"


def _base_url(request: Request) -> str:
    fija = os.environ.get("BASE_URL", "").strip().rstrip("/")
    if fija:
        return fija
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    return f"{proto}://{host}"


def _json(contenido, status_code: int = 200) -> JSONResponse:
    return JSONResponse(contenido, status_code=status_code, headers={"Cache-Control": "no-store"})


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _crear_sesion(usuario_id: int) -> str:
    token = secrets.token_urlsafe(32)
    ahora = datetime.now(timezone.utc)
    with _db() as db:
        db.execute("DELETE FROM sesiones WHERE expira < ?", (_ahora(),))   # limpieza de vencidas
        db.execute(
            "INSERT INTO sesiones (token_hash, usuario_id, creada, expira) VALUES (?, ?, ?, ?)",
            (
                _hash_token(token),
                usuario_id,
                ahora.strftime("%Y-%m-%dT%H:%M:%SZ"),
                (ahora + timedelta(days=SESION_DIAS)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            ),
        )
    return token


def usuario_actual(request: Request) -> Optional[dict]:
    token = request.cookies.get(COOKIE_SESION, "")
    if not token or len(token) > 200:
        return None
    with _db() as db:
        fila = db.execute(
            "SELECT u.id, u.nombre, u.email, u.avatar, u.proveedor "
            "FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id "
            "WHERE s.token_hash = ? AND s.expira > ?",
            (_hash_token(token), _ahora()),
        ).fetchone()
    return dict(fila) if fila else None


def _exigir_usuario(request: Request) -> dict:
    usuario = usuario_actual(request)
    if not usuario:
        raise HTTPException(status_code=401, detail="Iniciá sesión para continuar.")
    return usuario


def _exigir_ajax(request: Request):
    """Anti-CSRF: un formulario de otro sitio no puede mandar esta cabecera."""
    if request.headers.get("x-requested-with") != "fetch":
        raise HTTPException(status_code=403, detail="Solicitud no permitida.")


def _publico(usuario: Optional[dict]) -> Optional[dict]:
    if not usuario:
        return None
    avatar = usuario.get("avatar") or ""
    return {
        "nombre": usuario.get("nombre") or "Usuario",
        "email": usuario.get("email") or "",
        "avatar": avatar if avatar.startswith("https://") else "",
        "proveedor": usuario.get("proveedor") or "",
    }


def _volver(resultado: str) -> RedirectResponse:
    resp = RedirectResponse(f"/?login={resultado}", status_code=302)
    resp.delete_cookie(COOKIE_STATE, path="/")
    return resp


def _guardar_usuario(proveedor: str, perfil: dict) -> int:
    ahora = _ahora()
    nombre = (perfil.get("nombre") or "")[:80]
    email = (perfil.get("email") or "")[:200]
    avatar = (perfil.get("avatar") or "")[:500]
    with _db() as db:
        fila = db.execute(
            "SELECT id FROM usuarios WHERE proveedor = ? AND proveedor_id = ?",
            (proveedor, perfil["id"]),
        ).fetchone()
        if fila:
            db.execute(
                "UPDATE usuarios SET nombre = ?, email = ?, avatar = ?, ultimo_acceso = ? WHERE id = ?",
                (nombre, email, avatar, ahora, fila["id"]),
            )
            return fila["id"]
        cur = db.execute(
            "INSERT INTO usuarios (proveedor, proveedor_id, nombre, email, avatar, creado, ultimo_acceso) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (proveedor, perfil["id"], nombre, email, avatar, ahora, ahora),
        )
        return cur.lastrowid


# =====================================================================
# RUTAS DE LOGIN
# =====================================================================
@router.get("/api/auth/proveedores")
def auth_proveedores():
    return _json({"proveedores": [{"id": k, "nombre": PROVEEDORES[k]["nombre"]} for k in proveedores_activos()]})


@router.get("/api/auth/yo")
def auth_yo(request: Request):
    return _json({"usuario": _publico(usuario_actual(request))})


@router.get("/auth/login/{proveedor}")
def auth_login(proveedor: str, request: Request):
    cfg = PROVEEDORES.get(proveedor)
    cred = _credenciales(proveedor) if cfg else None
    if not cfg or not cred:
        return _volver("no_configurado")

    state = secrets.token_urlsafe(24)
    params = {
        "client_id": cred[0],
        "redirect_uri": f"{_base_url(request)}/auth/callback/{proveedor}",
        "response_type": "code",
        "scope": cfg["scope"],
        "state": state,
    }
    params.update(cfg["extra"])
    resp = RedirectResponse(f"{_url(cfg, 'autorizar')}?{urllib.parse.urlencode(params)}", status_code=302)
    resp.set_cookie(
        COOKIE_STATE, f"{proveedor}.{state}", max_age=600, httponly=True,
        samesite="lax", secure=_es_https(request), path="/",
    )
    return resp


@router.get("/auth/callback/{proveedor}")
def auth_callback(
    proveedor: str,
    request: Request,
    code: Optional[str] = None,
    state: Optional[str] = None,
    error: Optional[str] = None,
):
    cfg = PROVEEDORES.get(proveedor)
    cred = _credenciales(proveedor) if cfg else None
    if not cfg or not cred:
        return _volver("no_configurado")
    if error:
        return _volver("cancelado")

    esperado = request.cookies.get(COOKIE_STATE, "").encode("utf-8")
    recibido = f"{proveedor}.{state or ''}".encode("utf-8")
    if not code or not state or not secrets.compare_digest(esperado, recibido):
        return _volver("error")

    try:
        token = _http_json(_url(cfg, "token"), datos={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": f"{_base_url(request)}/auth/callback/{proveedor}",
            "client_id": cred[0],
            "client_secret": cred[1],
        })
        acceso = token.get("access_token")
        if not acceso:
            raise ValueError("el proveedor no devolvió access_token")
        crudo = _http_json(cfg["perfil"], cabeceras={"Authorization": f"Bearer {acceso}"})
        perfil = cfg["normalizar"](crudo)
        if not perfil["id"]:
            raise ValueError("el perfil no trae identificador")
    except Exception as e:
        # No se imprimen códigos ni secretos, solo el tipo de problema.
        print(f"[login] Falló el acceso con {proveedor}: {type(e).__name__}: {e}")
        return _volver("error")

    usuario_id = _guardar_usuario(proveedor, perfil)
    token_sesion = _crear_sesion(usuario_id)

    resp = RedirectResponse("/", status_code=302)
    resp.delete_cookie(COOKIE_STATE, path="/")
    resp.set_cookie(
        COOKIE_SESION, token_sesion, max_age=SESION_DIAS * 86400, httponly=True,
        samesite="lax", secure=_es_https(request), path="/",
    )
    return resp


@router.post("/api/auth/salir")
def auth_salir(request: Request):
    _exigir_ajax(request)
    token = request.cookies.get(COOKIE_SESION, "")
    if token:
        with _db() as db:
            db.execute("DELETE FROM sesiones WHERE token_hash = ?", (_hash_token(token),))
    resp = _json({"ok": True})
    resp.delete_cookie(COOKIE_SESION, path="/")
    return resp


# =====================================================================
# FAVORITOS POR USUARIO (se guardan por URL del canal)
# =====================================================================
class FavoritoIn(BaseModel):
    url: str


class FavoritosLote(BaseModel):
    urls: List[str]


def _url_valida(url: str) -> Optional[str]:
    limpia = (url or "").strip()
    if 0 < len(limpia) <= 2048 and limpia.lower().startswith(("http://", "https://")):
        return limpia
    return None


def _listar_favoritos(db, usuario_id: int) -> List[str]:
    filas = db.execute("SELECT url FROM favoritos WHERE usuario_id = ? ORDER BY rowid", (usuario_id,))
    return [f["url"] for f in filas]


@router.get("/api/favoritos")
def favoritos_listar(request: Request):
    usuario = _exigir_usuario(request)
    with _db() as db:
        return _json({"urls": _listar_favoritos(db, usuario["id"])})


@router.post("/api/favoritos")
def favoritos_agregar(datos: FavoritoIn, request: Request):
    _exigir_ajax(request)
    usuario = _exigir_usuario(request)
    url = _url_valida(datos.url)
    if not url:
        raise HTTPException(status_code=400, detail="URL de canal inválida.")
    with _db() as db:
        total = db.execute("SELECT COUNT(*) FROM favoritos WHERE usuario_id = ?", (usuario["id"],)).fetchone()[0]
        if total >= MAX_FAVORITOS:
            raise HTTPException(status_code=400, detail=f"Llegaste al máximo de {MAX_FAVORITOS} favoritos.")
        db.execute(
            "INSERT OR IGNORE INTO favoritos (usuario_id, url, creado) VALUES (?, ?, ?)",
            (usuario["id"], url, _ahora()),
        )
    return _json({"ok": True})


@router.delete("/api/favoritos")
def favoritos_quitar(url: str, request: Request):
    _exigir_ajax(request)
    usuario = _exigir_usuario(request)
    with _db() as db:
        db.execute("DELETE FROM favoritos WHERE usuario_id = ? AND url = ?", (usuario["id"], url.strip()))
    return _json({"ok": True})


@router.post("/api/favoritos/importar")
def favoritos_importar(datos: FavoritosLote, request: Request):
    """Sube de una vez los favoritos que el navegador tenía guardados antes del login."""
    _exigir_ajax(request)
    usuario = _exigir_usuario(request)
    with _db() as db:
        total = db.execute("SELECT COUNT(*) FROM favoritos WHERE usuario_id = ?", (usuario["id"],)).fetchone()[0]
        for crudo in datos.urls[:MAX_FAVORITOS]:
            if total >= MAX_FAVORITOS:
                break
            url = _url_valida(crudo)
            if not url:
                continue
            cur = db.execute(
                "INSERT OR IGNORE INTO favoritos (usuario_id, url, creado) VALUES (?, ?, ?)",
                (usuario["id"], url, _ahora()),
            )
            total += cur.rowcount
        return _json({"urls": _listar_favoritos(db, usuario["id"])})
