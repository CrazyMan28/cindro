"""Bearer-token auth for inbound HTTP requests (mirrors computer-use/auth.py).

Every path except /health is token-checked by the FastAPI middleware. Accepts
`Authorization: Bearer <t>` or the `?token=` fallback (fleet convention).
"""

import hmac
from typing import Optional

from fastapi import Request

from jarvis_mcp.config import get_bearer_token


def _token_ok(token: Optional[str]) -> bool:
    return bool(token) and hmac.compare_digest(token, get_bearer_token())


def _bearer_from_header(authorization: Optional[str]) -> Optional[str]:
    if not authorization:
        return None
    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1]


def request_ok(request: Request) -> bool:
    if _token_ok(_bearer_from_header(request.headers.get("Authorization"))):
        return True
    return _token_ok(request.query_params.get("token"))
