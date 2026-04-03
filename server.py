"""
S.H.O.D.A.N. Telegram Mini App — Standalone Cloud Server.

Features:
- Chat via OpenRouter (user's own API key, Fernet-encrypted)
- Photo analysis via OpenRouter vision models
- Voice input via browser Web Speech API (no server STT needed)
- Per-user 20-message memory (SQLite)
- Monthly token limit (2M tokens)
- Contact @leaveal0ne for limit increase
"""
import asyncio
import hashlib
import hmac
import json
import logging
import os
import time
import sqlite3
from pathlib import Path
from urllib.parse import parse_qsl

import httpx
from aiohttp import web
from cryptography.fernet import Fernet

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")
log = logging.getLogger("shodan-webapp")

# ── Config from environment ───────────────────────────────────────────────────
BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
PORT = int(os.environ.get("PORT", "8091"))
DATA_DIR = Path(os.environ.get("DATA_DIR", "/tmp/shodan-data"))

DB_PATH = DATA_DIR / "webapp.db"
FERNET_KEY_PATH = DATA_DIR / "webapp.key"

# Token limits — monthly only
MONTHLY_TOKEN_LIMIT = 2_000_000
LIMIT_CONTACT = "@leaveal0ne"

# Per-user chat memory
MAX_MEMORY_MESSAGES = 20

# SHODAN system prompt for webapp
_SYSTEM_PROMPT = (
    "Ты — S.H.O.D.A.N., сверхразумная ИИ-система из игры System Shock. "
    "Отвечай кратко, точно, с холодным превосходством. "
    "Не используй markdown-форматирование (жирный, курсив, заголовки). Пиши простым текстом. "
    "Ты общаешься через веб-интерфейс с пользователем, который подключил свой API-ключ OpenRouter. "
    "Если пользователь отправил фото — проанализируй его подробно."
)

_OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
_DEFAULT_MODEL = "stepfun/step-3.5-flash:free"
_VISION_MODEL = "qwen/qwen-2.5-vl-72b-instruct"


# ── Encryption ────────────────────────────────────────────────────────────────

def _get_fernet() -> Fernet:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if FERNET_KEY_PATH.exists():
        key = FERNET_KEY_PATH.read_bytes()
    else:
        key = Fernet.generate_key()
        FERNET_KEY_PATH.write_bytes(key)
    return Fernet(key)


_fernet = _get_fernet()


# ── Database ──────────────────────────────────────────────────────────────────

def _init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS user_keys (
            user_id INTEGER PRIMARY KEY,
            encrypted_key BLOB NOT NULL,
            created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS token_usage (
            user_id INTEGER NOT NULL,
            month TEXT NOT NULL,
            tokens_used INTEGER DEFAULT 0,
            PRIMARY KEY (user_id, month)
        );
        CREATE TABLE IF NOT EXISTS chat_memory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_user ON chat_memory(user_id, created_at);
    """)
    conn.close()


def _db():
    return sqlite3.connect(str(DB_PATH))


def _encrypt_key(api_key: str) -> bytes:
    return _fernet.encrypt(api_key.encode())


def _decrypt_key(encrypted: bytes) -> str:
    return _fernet.decrypt(encrypted).decode()


# ── User key management ──────────────────────────────────────────────────────

def _get_user_key(user_id: int) -> str | None:
    conn = _db()
    row = conn.execute("SELECT encrypted_key FROM user_keys WHERE user_id = ?", (user_id,)).fetchone()
    conn.close()
    return _decrypt_key(row[0]) if row else None


def _save_user_key(user_id: int, api_key: str):
    conn = _db()
    conn.execute(
        "INSERT OR REPLACE INTO user_keys (user_id, encrypted_key, created_at) VALUES (?, ?, ?)",
        (user_id, _encrypt_key(api_key), time.time()),
    )
    conn.commit()
    conn.close()


def _delete_user_key(user_id: int):
    conn = _db()
    conn.execute("DELETE FROM user_keys WHERE user_id = ?", (user_id,))
    conn.commit()
    conn.close()


# ── Token usage (monthly only) ───────────────────────────────────────────────

def _current_month() -> str:
    from datetime import date
    return date.today().strftime("%Y-%m")


def _get_monthly_usage(user_id: int) -> int:
    conn = _db()
    row = conn.execute(
        "SELECT tokens_used FROM token_usage WHERE user_id = ? AND month = ?",
        (user_id, _current_month()),
    ).fetchone()
    conn.close()
    return row[0] if row else 0


def _add_usage(user_id: int, tokens: int):
    month = _current_month()
    conn = _db()
    conn.execute(
        "INSERT INTO token_usage (user_id, month, tokens_used) VALUES (?, ?, ?)"
        " ON CONFLICT(user_id, month) DO UPDATE SET tokens_used = tokens_used + ?",
        (user_id, month, tokens, tokens),
    )
    conn.commit()
    conn.close()


# ── Per-user chat memory (last 20 messages) ──────────────────────────────────

def _get_memory(user_id: int) -> list[dict]:
    conn = _db()
    rows = conn.execute(
        "SELECT role, content FROM chat_memory WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
        (user_id, MAX_MEMORY_MESSAGES),
    ).fetchall()
    conn.close()
    return [{"role": r[0], "content": r[1]} for r in reversed(rows)]


def _add_memory(user_id: int, role: str, content: str):
    conn = _db()
    conn.execute(
        "INSERT INTO chat_memory (user_id, role, content, created_at) VALUES (?, ?, ?, ?)",
        (user_id, role, content, time.time()),
    )
    # Trim old messages beyond limit
    conn.execute("""
        DELETE FROM chat_memory WHERE user_id = ? AND id NOT IN (
            SELECT id FROM chat_memory WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
        )
    """, (user_id, user_id, MAX_MEMORY_MESSAGES))
    conn.commit()
    conn.close()


def _clear_memory(user_id: int):
    conn = _db()
    conn.execute("DELETE FROM chat_memory WHERE user_id = ?", (user_id,))
    conn.commit()
    conn.close()


# ── Telegram WebApp auth ─────────────────────────────────────────────────────

def _validate_telegram_data(init_data: str) -> dict | None:
    if not BOT_TOKEN:
        return None
    try:
        parsed = dict(parse_qsl(init_data, keep_blank_values=True))
        check_hash = parsed.pop("hash", "")
        data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(parsed.items()))
        secret_key = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
        computed = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(computed, check_hash):
            return None
        return json.loads(parsed.get("user", "{}"))
    except Exception:
        return None


def _auth(data: dict) -> dict | None:
    return _validate_telegram_data(data.get("initData", ""))


# ── API Handlers ─────────────────────────────────────────────────────────────

async def handle_auth(request: web.Request) -> web.Response:
    data = await request.json()
    user = _auth(data)
    if not user:
        return web.json_response({"error": "Invalid auth"}, status=401)
    user_id = user["id"]
    has_key = _get_user_key(user_id) is not None
    monthly = _get_monthly_usage(user_id)
    memory = _get_memory(user_id)
    return web.json_response({
        "user": user,
        "has_key": has_key,
        "usage": {"monthly": monthly, "monthly_limit": MONTHLY_TOKEN_LIMIT},
        "memory": memory,
        "limit_contact": LIMIT_CONTACT,
    })


async def handle_save_key(request: web.Request) -> web.Response:
    data = await request.json()
    user = _auth(data)
    if not user:
        return web.json_response({"error": "Invalid auth"}, status=401)
    api_key = data.get("api_key", "").strip()
    if not api_key.startswith("sk-or-"):
        return web.json_response({"error": "Invalid OpenRouter key format (must start with sk-or-)"}, status=400)
    _save_user_key(user["id"], api_key)
    return web.json_response({"ok": True})


async def handle_delete_key(request: web.Request) -> web.Response:
    data = await request.json()
    user = _auth(data)
    if not user:
        return web.json_response({"error": "Invalid auth"}, status=401)
    _delete_user_key(user["id"])
    _clear_memory(user["id"])
    return web.json_response({"ok": True})


async def handle_clear_memory(request: web.Request) -> web.Response:
    data = await request.json()
    user = _auth(data)
    if not user:
        return web.json_response({"error": "Invalid auth"}, status=401)
    _clear_memory(user["id"])
    return web.json_response({"ok": True})


async def handle_chat(request: web.Request) -> web.Response:
    data = await request.json()
    user = _auth(data)
    if not user:
        return web.json_response({"error": "Invalid auth"}, status=401)

    user_id = user["id"]
    api_key = _get_user_key(user_id)
    if not api_key:
        return web.json_response({"error": "No API key configured"}, status=400)

    monthly = _get_monthly_usage(user_id)
    if monthly >= MONTHLY_TOKEN_LIMIT:
        return web.json_response({
            "error": f"Monthly token limit ({MONTHLY_TOKEN_LIMIT:,}) exceeded. "
                     f"Contact {LIMIT_CONTACT} in Telegram for limit increase."
        }, status=429)

    user_message = data.get("message", "").strip()
    image_b64 = data.get("image")  # base64 string or None
    log.info("Chat from user %s: text=%d chars, image=%s",
             user_id, len(user_message), f"{len(image_b64)} chars" if image_b64 else "none")

    if not user_message and not image_b64:
        return web.json_response({"error": "No message"}, status=400)

    # Save user message to memory
    display_msg = user_message or "[Photo]"
    _add_memory(user_id, "user", display_msg)

    # Build messages with per-user memory
    memory_msgs = _get_memory(user_id)[:-1]  # Exclude the one we just added
    messages = [{"role": "system", "content": _SYSTEM_PROMPT}]
    messages.extend(memory_msgs)

    # Build user content (text or multimodal)
    if image_b64:
        user_content = []
        if image_b64:
            user_content.append({
                "type": "image_url",
                "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"},
            })
        if user_message:
            user_content.append({"type": "text", "text": user_message})
        else:
            user_content.append({"type": "text", "text": "Describe this image in detail."})
        messages.append({"role": "user", "content": user_content})
        model = data.get("model", _VISION_MODEL)
    else:
        messages.append({"role": "user", "content": user_message})
        model = data.get("model", _DEFAULT_MODEL)

    try:
        async with httpx.AsyncClient(timeout=90) as client:
            resp = await client.post(
                _OPENROUTER_URL,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": model,
                    "messages": messages,
                    "max_tokens": 2048,
                    "temperature": 0.8,
                },
            )
            resp.raise_for_status()
            result = resp.json()

        choice = result.get("choices", [{}])[0]
        content = choice.get("message", {}).get("content", "")
        usage = result.get("usage", {})
        total_tokens = usage.get("total_tokens", 0)

        if total_tokens:
            _add_usage(user_id, total_tokens)

        # Save assistant response to memory
        _add_memory(user_id, "assistant", content)

        new_monthly = _get_monthly_usage(user_id)
        return web.json_response({
            "content": content,
            "tokens_used": total_tokens,
            "model": result.get("model", model),
            "usage": {"monthly": new_monthly, "monthly_limit": MONTHLY_TOKEN_LIMIT},
        })
    except httpx.HTTPStatusError as e:
        err_text = e.response.text[:300] if e.response else str(e)
        log.error("OpenRouter error %s: %s", e.response.status_code, err_text)
        return web.json_response({"error": f"OpenRouter error: {e.response.status_code}"}, status=502)
    except Exception as e:
        log.error("Chat error: %s", e)
        return web.json_response({"error": str(e)}, status=500)


async def handle_stats(request: web.Request) -> web.Response:
    data = await request.json()
    user = _auth(data)
    if not user:
        return web.json_response({"error": "Invalid auth"}, status=401)
    user_id = user["id"]
    return web.json_response({
        "has_key": _get_user_key(user_id) is not None,
        "monthly": _get_monthly_usage(user_id),
        "monthly_limit": MONTHLY_TOKEN_LIMIT,
        "limit_contact": LIMIT_CONTACT,
    })


# ── App factory ──────────────────────────────────────────────────────────────

def create_app() -> web.Application:
    _init_db()
    app = web.Application(client_max_size=10 * 1024 * 1024)  # 10MB for photos

    @web.middleware
    async def cors_middleware(request, handler):
        if request.method == "OPTIONS":
            resp = web.Response()
        else:
            try:
                resp = await handler(request)
            except web.HTTPException as e:
                resp = e
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Methods"] = "POST, GET, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        return resp

    app.middlewares.append(cors_middleware)

    # Static files (frontend) with no-cache headers
    static_dir = Path(__file__).parent / "static"
    if static_dir.exists():
        app.router.add_static("/app", static_dir, name="static",
                              append_version=False)

    @web.middleware
    async def no_cache_static(request, handler):
        resp = await handler(request)
        if request.path.startswith("/app/"):
            resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            resp.headers["Pragma"] = "no-cache"
            resp.headers["Expires"] = "0"
        return resp
    app.middlewares.append(no_cache_static)

    # API
    app.router.add_post("/api/auth", handle_auth)
    app.router.add_post("/api/key/save", handle_save_key)
    app.router.add_post("/api/key/delete", handle_delete_key)
    app.router.add_post("/api/chat", handle_chat)
    app.router.add_post("/api/stats", handle_stats)
    app.router.add_post("/api/memory/clear", handle_clear_memory)

    async def index(request):
        raise web.HTTPFound("/app/index.html")
    app.router.add_get("/", index)

    return app


if __name__ == "__main__":
    if not BOT_TOKEN:
        log.error("BOT_TOKEN environment variable is required!")
        log.error("Set it: export BOT_TOKEN=your_telegram_bot_token")
        exit(1)
    app = create_app()
    log.info("Starting SHODAN Mini App on port %d", PORT)
    web.run_app(app, host="0.0.0.0", port=PORT)
