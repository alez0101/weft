#!/usr/bin/env python3
"""Create a stack's .env with fresh random secrets. Never overwrites an existing file.

    python3 -I tools/make_env.py --admin you@example.org     stacks/weft/.env (your Weft)
    python3 -I tools/make_env.py --test                      stacks/weft-test/.env (tests/run.sh does this itself)

Then read stacks/weft/.env.example for the optional settings (network, Cloudflare Access, Ollama).
"""
import argparse
import os
import secrets
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
ap = argparse.ArgumentParser()
ap.add_argument("--test", action="store_true")
ap.add_argument("--admin", default="", help="email of the first admin (made admin when they first sign in)")
a = ap.parse_args()
path = os.path.join(ROOT, "stacks", "weft-test" if a.test else "weft", ".env")
if os.path.exists(path):
    sys.exit(f"{path} already exists; not touching it")
pw = lambda: secrets.token_urlsafe(24)
lines = [
    "# Made by tools/make_env.py. Secrets: keep this file private and out of git.",
    f"OWNER_PASSWORD={pw()}", f"AUTHENTICATOR_PASSWORD={pw()}", f"AUTH_SVC_PASSWORD={pw()}",
    f"NOTIFY_SVC_PASSWORD={pw()}", f"ASSIST_SVC_PASSWORD={pw()}", f"COLLAB_SVC_PASSWORD={pw()}",
    f"JWT_SECRET={secrets.token_urlsafe(48)}",
    f"ASSIST_MASTER_KEY={secrets.token_hex(32)}",
    f"BOOTSTRAP_ADMIN_EMAIL={a.admin.strip().lower()}",
]
if a.test:
    lines.append("COOKIE_SECURE=false")
os.makedirs(os.path.dirname(path), exist_ok=True)
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as f:
    f.write("\n".join(lines) + "\n")
print(f"wrote {path}")
