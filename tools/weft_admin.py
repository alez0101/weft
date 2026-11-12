#!/usr/bin/env python3
"""Server-side admin tasks for Weft accounts, run on the machine that hosts Weft.

    python3 -I tools/weft_admin.py link you@example.org --url https://weft.example.org
        an invite link for a new account (the first admin starts here: use BOOTSTRAP_ADMIN_EMAIL)
    python3 -I tools/weft_admin.py link you@example.org --reset --url ...
        a password reset link for an existing account
    add --test to work on the test stack, --hours N to change how long the link lasts (default 24)

The link is printed once; only a hash of its secret is stored. Anyone with the link can set the
password, so hand it over privately. Admins can also make these links in Settings, People.
"""
import argparse
import hashlib
import os
import secrets
import subprocess
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
ap = argparse.ArgumentParser()
ap.add_argument("action", choices=["link"])
ap.add_argument("email")
ap.add_argument("--reset", action="store_true")
ap.add_argument("--url", default="", help="the address people open Weft at (default http://localhost:WEFT_PORT)")
ap.add_argument("--hours", type=int, default=24)
ap.add_argument("--test", action="store_true")
a = ap.parse_args()

docker = (os.environ.get("WEFT_DOCKER") or ("docker" if subprocess.run(["docker", "info"], capture_output=True).returncode == 0 else "sudo docker")).split()
if a.test:
    dc = docker + ["compose", "-p", "weft-test", "-f", f"{ROOT}/stacks/weft/compose.yaml", "-f", f"{ROOT}/stacks/weft-test/compose.test.yaml", "--env-file", f"{ROOT}/stacks/weft-test/.env"]
else:
    envf = f"{ROOT}/stacks/weft/.env"
    project = next((l.split("=", 1)[1].strip() for l in open(envf) if l.startswith("WEFT_PROJECT=")), "") or "weft-core"
    dc = docker + ["compose", "-p", project, "-f", f"{ROOT}/stacks/weft/compose.yaml", "--env-file", f"{ROOT}/stacks/weft/.env"]
secret = secrets.token_urlsafe(32)
q = lambda v: "'" + str(v).replace("'", "''") + "'"
sql = (f"select 'ok' from weft_private.auth_link_create({q(hashlib.sha256(secret.encode()).hexdigest())}, {q(a.email.strip().lower())}, "
       f"{q('reset' if a.reset else 'invite')}, null, {int(a.hours)});")
r = subprocess.run(dc + ["exec", "-T", "postgres", "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "weft_owner", "-d", "weft", "-c", sql],
                   capture_output=True, text=True)
if r.returncode != 0:
    sys.exit(r.stderr.strip().splitlines()[-1] if r.stderr.strip() else "failed")
print(f"{'Reset' if a.reset else 'Invite'} link for {a.email} (single use, {a.hours} hours):")
url = a.url or ("http://localhost:3210" if a.test else "http://localhost:" + (next((l.split("=", 1)[1].strip() for l in open(f"{ROOT}/stacks/weft/.env") if l.startswith("WEFT_PORT=")), "") or "3010"))
print(f"{url.rstrip('/')}/#link={secret}")
