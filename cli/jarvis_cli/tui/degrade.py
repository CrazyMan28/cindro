"""One shared helper for calling a daemon verb that might not be
implemented yet, degrading quietly on ``unknown_method`` (or any other
``ControlError``/``ConnectionError``/``TimeoutError``) instead of raising.

Before this module existed, three call sites had independently reinvented
this exact shape with three different result conventions:

* ``chat.py``'s ``_diff_action`` (the ``/stage`` ``/commit`` ``/revert``
  ``/openpr`` diff-review commands) distinguishes ``"unknown_method"`` (a
  quiet yellow transcript line) from any other failure (a red one), and
  returns early either way — a successful result is handled inline by the
  caller.
* ``settings_extras.py``'s ``_call_degrading`` (Connectors/Policies/
  extension-pairing) does the same unknown_method-vs-other split but writes
  into a ``Static`` status widget (falling back to a plain ``notify()`` if
  that widget isn't mounted), and returns the raw result dict on success or
  ``None`` on any failure — callers treat ``None`` as "didn't happen".
* ``phone_pane.py``'s ``_phone_mcp``/``_phone_http`` don't distinguish
  ``unknown_method`` at all — EVERY failure (including ``unknown_method``)
  folds into the same ``{"...": ..., "error": {"code": "transport_error",
  "message": ...}}`` shape, since their callers only ever check
  ``res.get("error")``.

``call_degrading`` supports all three shapes via optional callbacks rather
than picking one winner: ``on_unknown_method`` fires for the
``"unknown_method"`` ``ControlError`` case specifically (falling back to
``on_error`` if not given); ``on_error`` fires for every other
``ControlError``/``ConnectionError``/``TimeoutError``; ``on_success`` (given
the raw result) fires just before a successful result is returned. On
failure, ``wrap_error(exc)`` is returned if given (this is what lets
``phone_pane.py`` get its ``{"error": {...}}`` dict back), else plain
``None`` (the ``settings_extras.py``/``chat.py`` convention).
"""

from __future__ import annotations

from typing import Any, Callable, Optional

from jarvis_cli.control import ControlError


async def call_degrading(
    client,
    method: str,
    params: Optional[dict] = None,
    *,
    on_unknown_method: Optional[Callable[[Exception], None]] = None,
    on_error: Optional[Callable[[Exception], None]] = None,
    on_success: Optional[Callable[[Any], None]] = None,
    wrap_error: Optional[Callable[[Exception], Any]] = None,
    timeout: Optional[float] = None,
) -> Any:
    """Call ``method`` on ``client`` with ``params``, degrading quietly
    instead of raising on ControlError/ConnectionError/TimeoutError.

    - On success: ``on_success(result)`` runs (if given), then ``result`` is
      returned.
    - On a ``ControlError`` whose ``.code == "unknown_method"``:
      ``on_unknown_method(exc)`` runs if given, else ``on_error(exc)`` runs
      if given.
    - On any OTHER ``ControlError``, or a ``ConnectionError``/
      ``TimeoutError``: ``on_error(exc)`` runs if given.
    - Either failure path then returns ``wrap_error(exc)`` if given, else
      ``None``.
    """
    try:
        if timeout is not None:
            result = await client.call(method, params, timeout=timeout)
        else:
            result = await client.call(method, params)
    except ControlError as exc:
        if exc.code == "unknown_method":
            (on_unknown_method or on_error or (lambda _exc: None))(exc)
        elif on_error is not None:
            on_error(exc)
        return wrap_error(exc) if wrap_error is not None else None
    except (ConnectionError, TimeoutError) as exc:
        if on_error is not None:
            on_error(exc)
        return wrap_error(exc) if wrap_error is not None else None
    if on_success is not None:
        on_success(result)
    return result
