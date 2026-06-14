import json
import os
import re
import sys
import time
from pathlib import Path

from garminconnect import Garmin


garmin = None
mfa_pending = False
mfa_last_requested_at = 0.0
MFA_RESEND_COOLDOWN_SECONDS = 30
token_dir = str(Path(os.getenv("GARMIN_TOKEN_DIR", ".garmin-tokens")).resolve())


def mfa_details():
    if garmin is None or not mfa_pending:
        return {"pending": False}

    response = getattr(garmin.client, "_widget_last_resp", None)
    html = getattr(response, "text", "") or ""

    def value(name):
        match = re.search(rf'var {name} = "([^"]*)"', html)
        return match.group(1) if match else None

    title_match = re.search(r"<title>([^<]*)</title>", html, re.IGNORECASE)
    page_title = title_match.group(1) if title_match else None
    destination = value("codeSentTo")
    raw_method = value("mfaMethod") or getattr(garmin.client, "_mfa_method", None)
    if destination and "@" in destination:
        delivery_method = "email"
        guidance = (
            "Enter the six-digit code Garmin sent by email. This challenge does "
            "not require a Garmin Authentication App."
        )
    elif page_title and "authentication application" in page_title.lower():
        delivery_method = "email"
        guidance = (
            "Enter the six-digit code Garmin sent by email. Garmin's confusing "
            "Authentication Application page title is used for this email-code flow."
        )
    elif destination:
        delivery_method = "one-time code"
        guidance = "Enter the six-digit code Garmin sent to the masked destination."
    elif raw_method and str(raw_method).lower() in {"email", "sms"}:
        delivery_method = str(raw_method).lower()
        guidance = f"Enter the six-digit one-time code Garmin sent via {delivery_method}."
    else:
        delivery_method = "one-time code"
        guidance = (
            "Enter the latest six-digit code Garmin sent. Do not infer that a "
            "Garmin Authentication App is required from Garmin's internal method value."
        )

    return {
        "pending": True,
        "flow": getattr(garmin.client, "_mfa_flow", None),
        "deliveryMethod": delivery_method,
        "destination": destination,
        "page": page_title,
        "canResend": bool(value("customerGuid") and value("mfaMethod")),
        "guidance": guidance,
    }


def explicit_resend_mfa():
    global mfa_last_requested_at
    details = mfa_details()
    response = garmin.client._widget_last_resp
    html = response.text

    def required(name):
        match = re.search(rf'var {name} = "([^"]*)"', html)
        if not match:
            raise RuntimeError(f"Garmin MFA page did not contain {name}")
        return match.group(1)

    payload = {
        "customerGuid": required("customerGuid"),
        "mfaMethod": required("mfaMethod"),
        "locale": required("locale"),
    }
    result = garmin.client._mfa_session.post(
        "https://sso.garmin.com/sso/verifyMFA/mfaCode",
        params={"clientId": required("clientId")},
        json=payload,
        timeout=30,
    )
    if result.status_code == 429:
        raise RuntimeError(
            "Garmin refused another MFA code because its resend limit was reached. "
            "Wait before retrying."
        )
    if not result.ok:
        raise RuntimeError(f"Garmin MFA resend failed with HTTP {result.status_code}")
    mfa_last_requested_at = time.monotonic()
    return {**details, "requested": True, "requestMechanism": "explicit resend"}


def start_login():
    global garmin, mfa_pending, mfa_last_requested_at
    email = os.getenv("GARMIN_EMAIL")
    password = os.getenv("GARMIN_PASSWORD")
    if not email or not password:
        raise RuntimeError("GARMIN_EMAIL and GARMIN_PASSWORD must be set in .env")

    garmin = Garmin(email=email, password=password, return_on_mfa=True)
    # Widget MFA exposes Garmin's explicit resend-code endpoint when available.
    garmin.client.skip_strategies = [
        "mobile+cffi",
        "mobile+requests",
        "portal+cffi",
        "portal+requests",
    ]
    status, _ = garmin.login(token_dir)
    if status != "needs_mfa":
        garmin.client.dump(token_dir)
        mfa_pending = False
        return {"authenticated": True}

    mfa_pending = True
    # Posting credentials creates the challenge and triggers Garmin's automatic
    # email flow, including widget variants that expose no resend endpoint.
    mfa_last_requested_at = time.monotonic()
    details = mfa_details()
    if details["canResend"]:
        return explicit_resend_mfa()
    return {**details, "requested": True, "requestMechanism": "new login challenge"}


def resend_mfa():
    global garmin, mfa_pending
    details = mfa_details()
    if not details["pending"]:
        return start_login()

    elapsed = time.monotonic() - mfa_last_requested_at
    if elapsed < MFA_RESEND_COOLDOWN_SECONDS:
        wait_seconds = max(1, int(MFA_RESEND_COOLDOWN_SECONDS - elapsed))
        raise RuntimeError(
            f"Garmin MFA resend cooldown active. Retry in about {wait_seconds} seconds."
        )

    if details["flow"] == "widget" and details["canResend"]:
        return explicit_resend_mfa()

    # Some Garmin email-MFA pages expose no resend endpoint. Starting a fresh
    # widget login is the only way to ask Garmin to send another code.
    garmin = None
    mfa_pending = False
    return start_login()


def mfa_request_message(details):
    destination = f" to {details['destination']}" if details.get("destination") else ""
    return (
        f"Fresh Garmin MFA code requested via {details.get('deliveryMethod', 'email')}"
        f"{destination} using {details.get('requestMechanism', 'Garmin login')}. "
        "Call complete_garmin_mfa with the latest six-digit email code."
    )


def ensure_login():
    if garmin is not None and not mfa_pending:
        return None
    if mfa_pending:
        elapsed = time.monotonic() - mfa_last_requested_at
        if elapsed < MFA_RESEND_COOLDOWN_SECONDS:
            wait_seconds = max(1, int(MFA_RESEND_COOLDOWN_SECONDS - elapsed))
            return {
                **mfa_details(),
                "requested": False,
                "retryAfterSeconds": wait_seconds,
            }
        details = resend_mfa()
        return details

    details = start_login()
    if details.get("pending"):
        return details
    return None


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
    if method == "get_mfa_status":
        return mfa_details()
    if method == "resend_mfa":
        return resend_mfa()
    mfa = ensure_login()
    if mfa:
        return {
            "mfaRequired": True,
            **mfa,
            "message": (
                mfa_request_message(mfa)
                if mfa.get("requested")
                else "Garmin MFA is pending. Call complete_garmin_mfa with the "
                "latest six-digit email code."
            ),
        }
    return getattr(garmin, method)(*args)


for line in sys.stdin:
    request = json.loads(line)
    response = {"id": request["id"]}
    try:
        response["result"] = dispatch(request["method"], request.get("args", []))
    except Exception as error:
        response["error"] = str(error)
        print(f"Garmin bridge {request['method']} error: {error}", file=sys.stderr, flush=True)
    print(json.dumps(response, default=str), flush=True)
