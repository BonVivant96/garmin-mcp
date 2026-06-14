import json
import os
import re
import sys
from pathlib import Path

from garminconnect import Garmin


garmin = None
mfa_pending = False
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
    destination = value("codeSentTo")
    raw_method = value("mfaMethod") or getattr(garmin.client, "_mfa_method", None)
    if destination and "@" in destination:
        delivery_method = "email"
        guidance = (
            "Enter the six-digit code Garmin sent by email. This challenge does "
            "not require a Garmin Authentication App."
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
        "page": title_match.group(1) if title_match else None,
        "canResend": bool(value("customerGuid") and value("mfaMethod")),
        "guidance": guidance,
    }


def resend_mfa():
    details = mfa_details()
    if not details["pending"]:
        raise RuntimeError(
            "No Garmin MFA challenge is pending. Call any Garmin data tool first "
            "to start login."
        )
    if details["flow"] != "widget":
        raise RuntimeError(
            f"Garmin MFA resend is unavailable for the {details['flow']} login flow"
        )

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
    return {**details, "resent": True}


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
    # Widget MFA exposes Garmin's explicit resend-code endpoint.
    garmin.client.skip_strategies = [
        "mobile+cffi",
        "mobile+requests",
        "portal+cffi",
        "portal+requests",
    ]
    status, _ = garmin.login(token_dir)
    if status == "needs_mfa":
        mfa_pending = True
        details = mfa_details()
        if details["canResend"]:
            details = resend_mfa()
            message = (
                f"Fresh Garmin MFA code requested via {details['deliveryMethod']} to "
                f"{details['destination']}."
            )
        else:
            message = (
                "Garmin MFA challenge is pending, but Garmin did not permit an "
                "explicit resend. Use the most recent code Garmin already issued."
            )
        raise RuntimeError(
            f"{message} Call complete_garmin_mfa with the code."
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
    if method == "get_mfa_status":
        return mfa_details()
    if method == "resend_mfa":
        return resend_mfa()
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
