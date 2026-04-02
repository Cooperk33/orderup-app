#!/usr/bin/env /usr/bin/python3
import json
import hashlib
import hmac
import os
import queue
import re
import sqlite3
import threading
import time
import secrets
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8000"))
BASE_DIR = Path(__file__).parent
PUBLIC_DIR = BASE_DIR / "public"
DB_PATH = BASE_DIR / "app.db"
STAFF_PIN = os.environ.get("STAFF_PIN", "1111")
SESSION_TTL_SECONDS = 60 * 60 * 12


db_lock = threading.Lock()
subscribers = []
sessions = {}
sessions_lock = threading.Lock()


def utc_timestamp():
    return datetime.now(timezone.utc).isoformat()


def slugify(value):
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "table"


def init_db():
    with sqlite3.connect(DB_PATH) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS tables (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                label TEXT NOT NULL UNIQUE,
                slug TEXT NOT NULL UNIQUE,
                active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS alerts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                table_label TEXT NOT NULL,
                table_slug TEXT,
                request_type TEXT NOT NULL,
                note TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                acknowledged_at TEXT
            )
            """
        )
        connection.commit()


def get_db_connection():
    connection = sqlite3.connect(DB_PATH, check_same_thread=False)
    connection.row_factory = sqlite3.Row
    return connection


def fetch_alerts(limit=100):
    with db_lock, get_db_connection() as connection:
        rows = connection.execute(
            """
            SELECT id, table_label, table_slug, request_type, note, status, created_at, acknowledged_at
            FROM alerts
            ORDER BY datetime(created_at) DESC, id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [serialize_alert(row) for row in rows]


def fetch_tables():
    with db_lock, get_db_connection() as connection:
        rows = connection.execute(
            """
            SELECT id, label, slug, active, created_at
            FROM tables
            ORDER BY active DESC, label COLLATE NOCASE ASC
            """
        ).fetchall()
    return [serialize_table(row) for row in rows]


def get_table_by_slug(slug):
    with db_lock, get_db_connection() as connection:
        row = connection.execute(
            """
            SELECT id, label, slug, active, created_at
            FROM tables
            WHERE slug = ?
            """,
            (slug,),
        ).fetchone()
    return serialize_table(row) if row else None


def create_table(label):
    base_slug = slugify(label)
    slug = base_slug
    suffix = 2

    with db_lock, get_db_connection() as connection:
        while connection.execute("SELECT 1 FROM tables WHERE slug = ?", (slug,)).fetchone():
            slug = f"{base_slug}-{suffix}"
            suffix += 1

        connection.execute(
            """
            INSERT INTO tables (label, slug, active, created_at)
            VALUES (?, ?, 1, ?)
            """,
            (label, slug, utc_timestamp()),
        )
        connection.commit()

        row = connection.execute(
            """
            SELECT id, label, slug, active, created_at
            FROM tables
            WHERE slug = ?
            """,
            (slug,),
        ).fetchone()

    return serialize_table(row)


def create_bulk_tables(prefix, count, start_at):
    created = []
    for number in range(start_at, start_at + count):
        created.append(create_table(f"{prefix} {number}"))
    return created


def update_table_status(table_id, active):
    with db_lock, get_db_connection() as connection:
        connection.execute(
            "UPDATE tables SET active = ? WHERE id = ?",
            (1 if active else 0, table_id),
        )
        connection.commit()
        row = connection.execute(
            """
            SELECT id, label, slug, active, created_at
            FROM tables
            WHERE id = ?
            """,
            (table_id,),
        ).fetchone()
    return serialize_table(row) if row else None


def insert_alert(table_label, table_slug, request_type, note):
    with db_lock, get_db_connection() as connection:
        cursor = connection.execute(
            """
            INSERT INTO alerts (
                table_label,
                table_slug,
                request_type,
                note,
                status,
                created_at,
                acknowledged_at
            )
            VALUES (?, ?, ?, ?, 'pending', ?, NULL)
            """,
            (table_label, table_slug, request_type, note, utc_timestamp()),
        )
        connection.commit()
        row = connection.execute(
            """
            SELECT id, table_label, table_slug, request_type, note, status, created_at, acknowledged_at
            FROM alerts
            WHERE id = ?
            """,
            (cursor.lastrowid,),
        ).fetchone()
    return serialize_alert(row)


def acknowledge_alert(alert_id):
    with db_lock, get_db_connection() as connection:
        row = connection.execute(
            """
            SELECT id, table_label, table_slug, request_type, note, status, created_at, acknowledged_at
            FROM alerts
            WHERE id = ?
            """,
            (alert_id,),
        ).fetchone()

        if not row:
            return None

        if row["status"] != "acknowledged":
            connection.execute(
                """
                UPDATE alerts
                SET status = 'acknowledged', acknowledged_at = ?
                WHERE id = ?
                """,
                (utc_timestamp(), alert_id),
            )
            connection.commit()
            row = connection.execute(
                """
                SELECT id, table_label, table_slug, request_type, note, status, created_at, acknowledged_at
                FROM alerts
                WHERE id = ?
                """,
                (alert_id,),
            ).fetchone()

    return serialize_alert(row)


def serialize_alert(row):
    return {
        "id": row["id"],
        "table": row["table_label"],
        "tableSlug": row["table_slug"],
        "requestType": row["request_type"],
        "note": row["note"],
        "status": row["status"],
        "createdAt": row["created_at"],
        "acknowledgedAt": row["acknowledged_at"],
    }


def serialize_table(row):
    return {
        "id": row["id"],
        "label": row["label"],
        "slug": row["slug"],
        "active": bool(row["active"]),
        "createdAt": row["created_at"],
    }


def broadcast(event_type, payload):
    stale = []
    for subscriber in subscribers:
        try:
            subscriber.put_nowait((event_type, payload))
        except Exception:
            stale.append(subscriber)

    for subscriber in stale:
        try:
            subscribers.remove(subscriber)
        except ValueError:
            pass


def create_session():
    token = secrets.token_urlsafe(32)
    expiry = time.time() + SESSION_TTL_SECONDS
    with sessions_lock:
        sessions[token] = expiry
    return token


def is_valid_session(token):
    if not token:
        return False

    now = time.time()
    with sessions_lock:
        expired = [value for value, expiry in sessions.items() if expiry <= now]
        for value in expired:
            sessions.pop(value, None)

        expiry = sessions.get(token)
        if not expiry:
            return False

        sessions[token] = now + SESSION_TTL_SECONDS
        return True


def destroy_session(token):
    if not token:
        return
    with sessions_lock:
        sessions.pop(token, None)


class RequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/login":
            self.path = "/login.html"
            return super().do_GET()

        if path == "/logout":
            self._logout()
            return

        if path.startswith("/api/"):
            if self._is_protected_api(path) and not self._require_staff_auth(api=True):
                return

        if path == "/api/alerts":
            self._send_json({"alerts": fetch_alerts()})
            return

        if path == "/api/tables":
            self._send_json({"tables": fetch_tables()})
            return

        if path.startswith("/api/table/"):
            slug = path.removeprefix("/api/table/")
            table = get_table_by_slug(slug)
            if not table:
                self._send_json({"error": "Table not found."}, status=HTTPStatus.NOT_FOUND)
                return
            self._send_json({"table": table})
            return

        if path == "/api/stream":
            self._handle_stream()
            return

        if path == "/":
            self.path = "/home.html"
        elif path == "/customer":
            self.path = "/customer.html"
        elif path == "/server":
            if not self._require_staff_auth():
                return
            self.path = "/server.html"
        elif path == "/admin":
            if not self._require_staff_auth():
                return
            self.path = "/admin.html"
        elif path.startswith("/table/"):
            self.path = "/customer.html"

        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/login":
            self._login()
            return

        if path.startswith("/api/") and self._is_protected_api(path):
            if not self._require_staff_auth(api=True):
                return

        if path == "/api/ping":
            self._create_alert()
            return

        if path == "/api/acknowledge":
            self._acknowledge_alert()
            return

        if path == "/api/tables":
            self._create_table()
            return

        if path == "/api/tables/bulk":
            self._create_bulk_tables()
            return

        if path == "/api/tables/status":
            self._update_table_status()
            return

        self.send_error(HTTPStatus.NOT_FOUND, "Endpoint not found")

    def log_message(self, format, *args):
        return

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            self._send_json({"error": "Invalid JSON payload."}, status=HTTPStatus.BAD_REQUEST)
            return None

    def _send_json(self, payload, status=HTTPStatus.OK):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _redirect(self, location):
        self.send_response(HTTPStatus.FOUND)
        self.send_header("Location", location)
        self.end_headers()

    def _cookie_value(self, name):
        raw_cookie = self.headers.get("Cookie", "")
        if not raw_cookie:
            return None

        for part in raw_cookie.split(";"):
            key, _, value = part.strip().partition("=")
            if key == name:
                return value
        return None

    def _is_authenticated(self):
        token = self._cookie_value("staff_session")
        return is_valid_session(token)

    def _is_protected_api(self, path):
        protected = (
            "/api/alerts",
            "/api/acknowledge",
            "/api/tables",
            "/api/tables/bulk",
            "/api/tables/status",
            "/api/stream",
        )
        return path in protected

    def _require_staff_auth(self, api=False):
        if self._is_authenticated():
            return True

        if api:
            self._send_json({"error": "Authentication required."}, status=HTTPStatus.UNAUTHORIZED)
        else:
            target = urlparse(self.path).path
            self._redirect(f"/login?next={target}")
        return False

    def _login(self):
        payload = self._read_json_body()
        if payload is None:
            return

        pin = str(payload.get("pin", "")).strip()
        next_path = str(payload.get("next", "/server")).strip() or "/server"

        if not hmac.compare_digest(hashlib.sha256(pin.encode("utf-8")).hexdigest(), hashlib.sha256(STAFF_PIN.encode("utf-8")).hexdigest()):
            self._send_json({"error": "Incorrect PIN."}, status=HTTPStatus.UNAUTHORIZED)
            return

        token = create_session()
        response = json.dumps({"ok": True, "redirectTo": next_path}).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(response)))
        self.send_header("Set-Cookie", f"staff_session={token}; HttpOnly; Path=/; Max-Age={SESSION_TTL_SECONDS}; SameSite=Lax")
        self.end_headers()
        self.wfile.write(response)

    def _logout(self):
        destroy_session(self._cookie_value("staff_session"))
        self.send_response(HTTPStatus.FOUND)
        self.send_header("Location", "/login")
        self.send_header("Set-Cookie", "staff_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax")
        self.end_headers()

    def _create_alert(self):
        payload = self._read_json_body()
        if payload is None:
            return

        request_type = str(payload.get("requestType", "")).strip() or "General help"
        note = str(payload.get("note", "")).strip()
        table_slug = str(payload.get("tableSlug", "")).strip()
        table_label = str(payload.get("table", "")).strip()

        if table_slug:
            table = get_table_by_slug(table_slug)
            if not table or not table["active"]:
                self._send_json({"error": "This table link is not active."}, status=HTTPStatus.BAD_REQUEST)
                return
            table_label = table["label"]
        elif not table_label:
            self._send_json({"error": "Table is required."}, status=HTTPStatus.BAD_REQUEST)
            return

        alert = insert_alert(table_label, table_slug or None, request_type, note)
        broadcast("new-alert", alert)
        self._send_json({"ok": True, "alert": alert}, status=HTTPStatus.CREATED)

    def _acknowledge_alert(self):
        payload = self._read_json_body()
        if payload is None:
            return

        alert_id = payload.get("id")
        if not isinstance(alert_id, int):
            self._send_json({"error": "A numeric alert id is required."}, status=HTTPStatus.BAD_REQUEST)
            return

        updated = acknowledge_alert(alert_id)
        if not updated:
            self._send_json({"error": "Alert not found."}, status=HTTPStatus.NOT_FOUND)
            return

        broadcast("alert-updated", updated)
        self._send_json({"ok": True, "alert": updated})

    def _create_table(self):
        payload = self._read_json_body()
        if payload is None:
            return

        label = str(payload.get("label", "")).strip()
        if not label:
            self._send_json({"error": "Table label is required."}, status=HTTPStatus.BAD_REQUEST)
            return

        try:
            table = create_table(label)
        except sqlite3.IntegrityError:
            self._send_json({"error": "That table already exists."}, status=HTTPStatus.CONFLICT)
            return

        broadcast("tables-updated", {"tables": fetch_tables()})
        self._send_json({"ok": True, "table": table}, status=HTTPStatus.CREATED)

    def _create_bulk_tables(self):
        payload = self._read_json_body()
        if payload is None:
            return

        prefix = str(payload.get("prefix", "")).strip() or "Table"
        count = payload.get("count")
        start_at = payload.get("startAt", 1)

        if not isinstance(count, int) or count < 1 or count > 100:
            self._send_json({"error": "Count must be a number between 1 and 100."}, status=HTTPStatus.BAD_REQUEST)
            return

        if not isinstance(start_at, int) or start_at < 1:
            self._send_json({"error": "Start number must be 1 or greater."}, status=HTTPStatus.BAD_REQUEST)
            return

        created = create_bulk_tables(prefix, count, start_at)
        broadcast("tables-updated", {"tables": fetch_tables()})
        self._send_json({"ok": True, "tables": created}, status=HTTPStatus.CREATED)

    def _update_table_status(self):
        payload = self._read_json_body()
        if payload is None:
            return

        table_id = payload.get("id")
        active = payload.get("active")

        if not isinstance(table_id, int) or not isinstance(active, bool):
            self._send_json({"error": "A numeric table id and boolean active value are required."}, status=HTTPStatus.BAD_REQUEST)
            return

        table = update_table_status(table_id, active)
        if not table:
            self._send_json({"error": "Table not found."}, status=HTTPStatus.NOT_FOUND)
            return

        broadcast("tables-updated", {"tables": fetch_tables()})
        self._send_json({"ok": True, "table": table})

    def _handle_stream(self):
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

        subscriber = queue.Queue()
        subscribers.append(subscriber)

        try:
            self._write_event(
                "bootstrap",
                {
                    "alerts": fetch_alerts(),
                    "tables": fetch_tables(),
                },
            )

            while True:
                try:
                    event_type, payload = subscriber.get(timeout=20)
                    self._write_event(event_type, payload)
                except queue.Empty:
                    self.wfile.write(b": keep-alive\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            try:
                subscribers.remove(subscriber)
            except ValueError:
                pass

    def _write_event(self, event_type, payload):
        message = f"event: {event_type}\ndata: {json.dumps(payload)}\n\n".encode("utf-8")
        self.wfile.write(message)
        self.wfile.flush()


if __name__ == "__main__":
    init_db()
    server = ThreadingHTTPServer((HOST, PORT), RequestHandler)
    print(f"Serving on http://{HOST}:{PORT}")
    server.serve_forever()
