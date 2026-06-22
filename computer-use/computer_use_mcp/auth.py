"""Bearer-token auth for HTTP requests and the extension WebSocket."""

import hmac
from typing import Optional

from fastapi import Request, WebSocket

from computer_use_mcp.config import get_bearer_token


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
    """Authorization: Bearer header, or ?token= fallback (fleet convention)."""
    if _token_ok(_bearer_from_header(request.headers.get("Authorization"))):
        return True
    return _token_ok(request.query_params.get("token"))


def ws_ok(websocket: WebSocket) -> bool:
    """WebSocket scopes bypass the HTTP middleware — checked at the endpoint."""
    if _token_ok(_bearer_from_header(websocket.headers.get("Authorization"))):
        return True
    return _token_ok(websocket.query_params.get("token"))
