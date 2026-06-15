import hashlib
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
mfa_last_attempt_at = 0.0
failed_mfa_code_hashes = set()
MFA_RESEND_COOLDOWN_SECONDS = 300
MFA_ATTEMPT_COOLDOWN_SECONDS = 30
token_dir = str(Path(os.getenv("GARMIN_TOKEN_DIR", ".garmin-tokens")).resolve())


def mfa_details():
    if garmin is None or not mfa_pending:
        return {"pending": False}

    response = getattr(garmin.client, "_widget_last_resp", None)
    html = getattr(response, "text", "") or ""

    def value(name):
        # var/let/const declaration
        match = re.search(
            rf"\b(?:var|let|const)\s+{re.escape(name)}\s*=\s*(['\"])(.*?)\1",
            html,
            re.DOTALL,
        )
        if match:
            return match.group(2)
        # Object / JSON property:  "name": "value"  or  name: 'value'
        match = re.search(
            rf"""['\"]?{re.escape(name)}['\"]?\s*:\s*(['\"])(.*?)\1""",
            html,
            re.DOTALL,
        )
        return match.group(2) if match else None

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

    # canResend = True only when customerGuid is extractable — verifyMFA/mfaCode
    # requires it and returns 401 without it. Portal/iOS flows that auto-send
    # the email are handled in start_login() before reaching explicit_resend_mfa().
    can_resend = bool(value("customerGuid") and (value("mfaMethod") or getattr(garmin.client, "_mfa_method", None)))
    if not can_resend and html:
        print(
            f"[garmin-bridge] canResend=False. title={page_title!r} "
            f"html_len={len(html)} snippet={html[:2000]!r}",
            file=sys.stderr,
            flush=True,
        )

    # Debug: try to expose customerGuid location and cookies for investigation
    cg_in_html = bool(re.search(r"customerGuid", html, re.IGNORECASE))
    try:
        cookie_keys = sorted(dict(getattr(getattr(garmin.client, "_mfa_session", None), "cookies", {})).keys())
    except Exception:
        cookie_keys = None

    return {
        "pending": True,
        "flow": getattr(garmin.client, "_mfa_flow", None),
        "deliveryMethod": delivery_method,
        "destination": destination,
        "page": page_title,
        "canResend": can_resend,
        "guidance": guidance,
        "_debug": {"customerGuidInHtml": cg_in_html, "cookieKeys": cookie_keys},
    }


def explicit_resend_mfa():
    global mfa_last_requested_at
    details = mfa_details()
    response = getattr(garmin.client, "_widget_last_resp", None)
    html = getattr(response, "text", "") or ""

    def optional(name):
        # var/let/const declaration
        m = re.search(
            rf"\b(?:var|let|const)\s+{re.escape(name)}\s*=\s*(['\"])(.*?)\1",
            html, re.DOTALL,
        )
        if m:
            return m.group(2)
        # object/JSON property
        m = re.search(
            rf"""['\"]?{re.escape(name)}['\"]?\s*:\s*(['\"])(.*?)\1""",
            html, re.DOTALL,
        )
        if m:
            return m.group(2)
        # HTML hidden input:  <input ... name="customerGuid" ... value="xxx">
        m = re.search(
            rf"""<input[^>]+name=['\"]?{re.escape(name)}['\"]?[^>]+value=['\"]([^'\"]+)['\"]""",
            html, re.DOTALL | re.IGNORECASE,
        )
        if m:
            return m.group(1)
        # Also try value before name:  <input ... value="xxx" ... name="customerGuid">
        m = re.search(
            rf"""<input[^>]+value=['\"]([^'\"]+)['\"][^>]+name=['\"]?{re.escape(name)}['\"]?""",
            html, re.DOTALL | re.IGNORECASE,
        )
        return m.group(1) if m else None

    mfa_method = optional("mfaMethod") or getattr(garmin.client, "_mfa_method", None) or "EMAIL"
    locale = optional("locale") or "en-US"
    client_id = optional("clientId") or "GarminConnect"
    customer_guid = optional("customerGuid")  # None OK — session cookies identify user

    payload = {"mfaMethod": mfa_method, "locale": locale}
    if customer_guid:
        payload["customerGuid"] = customer_guid

    # Diagnostic: locate customerGuid in HTML and dump cookies
    cg_match = re.search(r"customerGuid", html, re.IGNORECASE)
    if cg_match:
        s, e = max(0, cg_match.start() - 30), min(len(html), cg_match.end() + 150)
        print(f"[garmin-bridge] customerGuid found at {cg_match.start()}: {html[s:e]!r}", file=sys.stderr, flush=True)
    else:
        print(f"[garmin-bridge] customerGuid NOT in HTML (len={len(html)})", file=sys.stderr, flush=True)
    try:
        cookie_keys = list(dict(garmin.client._mfa_session.cookies).keys())
        print(f"[garmin-bridge] session cookie keys: {cookie_keys}", file=sys.stderr, flush=True)
    except Exception as ce:
        print(f"[garmin-bridge] can't read cookies: {ce}", file=sys.stderr, flush=True)
    print(
        f"[garmin-bridge] explicit_resend_mfa: method={mfa_method} "
        f"guid={'present' if customer_guid else 'absent'} clientId={client_id}",
        file=sys.stderr, flush=True,
    )
    result = garmin.client._mfa_session.post(
        "https://sso.garmin.com/sso/verifyMFA/mfaCode",
        params={"clientId": client_id},
        headers=getattr(garmin.client, "_mfa_post_headers", {}),
        json=payload,
        timeout=30,
    )
    print(
        f"[garmin-bridge] verifyMFA/mfaCode response: {result.status_code}",
        file=sys.stderr, flush=True,
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
    global garmin, mfa_pending, mfa_last_attempt_at, failed_mfa_code_hashes
    email = os.getenv("GARMIN_EMAIL")
    password = os.getenv("GARMIN_PASSWORD")
    if not email or not password:
        raise RuntimeError("GARMIN_EMAIL and GARMIN_PASSWORD must be set in .env")

    failed_mfa_code_hashes = set()
    garmin = Garmin(email=email, password=password, return_on_mfa=True)
    # mobile+cffi (primary): Garmin auto-sends the email via the iOS API with
    # no anti-WAF delay. Falls back to widget+cffi which can use
    # explicit_resend_mfa() when customerGuid is in the page HTML.
    garmin.client.skip_strategies = {
        "mobile+requests",
        "portal+cffi",
        "portal+requests",
    }
    status, _ = garmin.login(token_dir)
    if status != "needs_mfa":
        garmin.client.dump(token_dir)
        mfa_pending = False
        return {"authenticated": True}

    mfa_pending = True
    mfa_last_attempt_at = time.monotonic()
    details = mfa_details()

    # Portal/iOS flow: Garmin auto-sent the email when credentials were posted.
    mfa_flow = getattr(garmin.client, "_mfa_flow", None)
    mfa_method = str(getattr(garmin.client, "_mfa_method", "") or "")
    if mfa_flow in {"portal", "ios"} and mfa_method.lower() in {"email", "sms"}:
        return {
            **details,
            "requested": True,
            "requestMechanism": f"Garmin {mfa_flow} login",
            "reason": None,
        }

    # Widget flow: try explicit POST to verifyMFA/mfaCode (requires customerGuid).
    if details["canResend"]:
        return explicit_resend_mfa()

    # Widget email MFA (page title "Authentication Application") without customerGuid:
    # Garmin sends the code server-side when the MFA session is created. The
    # verifyMFA/mfaCode endpoint (resend) is inaccessible without customerGuid, but
    # the initial code is already in transit. Returning requested=True stops Claude
    # from looping on resends and tells the user to check their inbox.
    if details.get("deliveryMethod") == "email":
        return {
            **details,
            "requested": True,
            "requestMechanism": "Garmin login",
            "reason": (
                "Garmin sent the code when credentials were submitted. "
                "The explicit resend endpoint is inaccessible (customerGuid absent). "
                "Check email and spam for the six-digit code."
            ),
        }

    return {
        **details,
        "requested": False,
        "requestMechanism": None,
        "reason": "Garmin MFA triggered but email delivery method not confirmed.",
    }


def resend_mfa():
    global garmin, mfa_pending
    details = mfa_details()
    if not details["pending"]:
        return start_login()

    if mfa_last_requested_at:
        elapsed = time.monotonic() - mfa_last_requested_at
    else:
        elapsed = MFA_RESEND_COOLDOWN_SECONDS
    if elapsed < MFA_RESEND_COOLDOWN_SECONDS:
        wait_seconds = max(1, int(MFA_RESEND_COOLDOWN_SECONDS - elapsed))
        raise RuntimeError(
            f"Garmin MFA resend cooldown active. Retry in about {wait_seconds} seconds. "
            "Repeated requests can prevent Garmin from sending another email."
        )

    if details["flow"] == "widget" and details["canResend"]:
        return explicit_resend_mfa()

    attempt_elapsed = time.monotonic() - mfa_last_attempt_at
    if attempt_elapsed < MFA_ATTEMPT_COOLDOWN_SECONDS:
        wait_seconds = max(1, int(MFA_ATTEMPT_COOLDOWN_SECONDS - attempt_elapsed))
        raise RuntimeError(
            "No Garmin MFA email send was confirmed. Retry the resend tool in about "
            f"{wait_seconds} seconds."
        )

    # Some Garmin email-MFA pages expose no resend endpoint. Start one fresh
    # widget challenge after cooldown; do not loop against Garmin.
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
        return {
            **mfa_details(),
            "requested": False,
            "message": (
                "Garmin MFA is pending. Call complete_garmin_mfa with the latest "
                "six-digit email code, or call resend_garmin_mfa once if no new "
                "email arrived."
            ),
        }

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
    code_hash = hashlib.sha256(code.encode()).hexdigest()
    if code_hash in failed_mfa_code_hashes:
        raise RuntimeError(
            "Garmin already rejected this MFA code. Do not retry it; use the newest "
            "email code or wait before requesting one fresh code."
        )
    try:
        garmin.client._complete_mfa(code)
    except Exception as error:
        failed_mfa_code_hashes.add(code_hash)
        raise RuntimeError(
            f"Garmin rejected this MFA code: {error}. Do not retry the same code."
        ) from error
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
        if request["method"] == "shutdown":
            response["result"] = {"stopped": True}
        else:
            response["result"] = dispatch(request["method"], request.get("args", []))
    except Exception as error:
        response["error"] = str(error)
        print(f"Garmin bridge {request['method']} error: {error}", file=sys.stderr, flush=True)
    print(json.dumps(response, default=str), flush=True)
    if request["method"] == "shutdown":
        break
