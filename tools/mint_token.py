#!/usr/bin/env python3
"""Mint a PostgREST token (HS256) for local testing. Phase 3 replaces this with the token service.

Usage: python3 -I tools/mint_token.py <user-key> [--assistant] [--scope <space-key>] [--ttl 3600]
User keys: u-alex u-org u-vol u-pub. Space keys: festival volunteers organizers dm-... personal-...
The secret is read from stacks/weft/.env. Never expose a minted token beyond the Weft server.
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
import time
import uuid

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
NS = uuid.UUID("6f1c2a52-5a2f-4c9e-9a0e-7b1f0d3e5a11")   # same namespace as gen_seed.py


def uid(*parts):
    return str(uuid.uuid5(NS, "/".join(parts)))


def secret():
    with open(os.path.join(ROOT, "stacks", "weft", ".env")) as f:
        for line in f:
            if line.startswith("JWT_SECRET="):
                return line.split("=", 1)[1].strip()
    raise SystemExit("JWT_SECRET not found in stacks/weft/.env")


def b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def mint(user_key, assistant=False, scope=None, ttl=3600, key=None):
    claims = {"role": "weft_assistant" if assistant else "weft_user",
              "sub": uid("user", user_key), "exp": int(time.time()) + ttl}
    if scope:
        claims["scope_space"] = uid("space", scope)
    head = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    body = b64(json.dumps(claims).encode())
    sig = hmac.new((key or secret()).encode(), f"{head}.{body}".encode(), hashlib.sha256).digest()
    return f"{head}.{body}.{b64(sig)}"


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("user")
    ap.add_argument("--assistant", action="store_true")
    ap.add_argument("--scope")
    ap.add_argument("--ttl", type=int, default=3600)
    a = ap.parse_args()
    print(mint(a.user, a.assistant, a.scope, a.ttl))
