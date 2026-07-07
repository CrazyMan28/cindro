"""Bearer-token auth for inbound HTTP (mirrors outpost-mcp/auth.py). Only the
co-located jarvisd (pointed at proxmoxAgentEndpoint()) ever calls this
service, but it's still bearer-gated — defense in depth against any other
local process on the same host."""

import hmac
from typing import Optional

from fastapi import Request

from proxmox_mcp.config import get_bearer_token


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
