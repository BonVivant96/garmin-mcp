import json
import os
import sys
from pathlib import Path

from garminconnect import Garmin


garmin = None
mfa_pending = False
token_dir = str(Path(os.getenv("GARMIN_TOKEN_DIR", ".garmin-tokens")).resolve())


def ensure_login():
    global garmin, mfa_pending
    if garmin is not None and not mfa_pending:
        return
    if mfa_pending:
        raise RuntimeError(
            "Garmin MFA code required. Check your email or phone, then call "
            "complete_garmin_mfa with the code."
        )

    email = os.getenv("GARMIN_EMAIL")
    password = os.getenv("GARMIN_PASSWORD")
    if not email or not password:
        raise RuntimeError("GARMIN_EMAIL and GARMIN_PASSWORD must be set in .env")

    garmin = Garmin(email=email, password=password, return_on_mfa=True)
    status, _ = garmin.login(token_dir)
    if status == "needs_mfa":
        mfa_pending = True
        raise RuntimeError(
            "Garmin MFA code required. Check your email or phone, then call "
            "complete_garmin_mfa with the code."
        )
    garmin.client.dump(token_dir)


def complete_mfa(code):
    global mfa_pending
    if garmin is None or not mfa_pending:
        raise RuntimeError(
            "No Garmin MFA challenge is pending. Call any Garmin data tool first "
            "to start login."
        )
    garmin.client._complete_mfa(code)
    garmin.client.dump(token_dir)
    mfa_pending = False
    return {"authenticated": True}


def dispatch(method, args):
    if method == "complete_mfa":
        return complete_mfa(*args)
    ensure_login()
    return getattr(garmin, method)(*args)


for line in sys.stdin:
    request = json.loads(line)
    response = {"id": request["id"]}
    try:
        response["result"] = dispatch(request["method"], request.get("args", []))
    except Exception as error:
        response["error"] = str(error)
    print(json.dumps(response, default=str), flush=True)
