"""Pre-exec shell-command scanner — a weighted-cue destruction/exfil detector.

jarvis#76 (feature 12): the free-form command tools (``bg_start``, ``monitor``,
``watch``, ``widget_live``) run their ``command`` argument through
``subprocess(..., shell=True)`` in a DETACHED runner. Once that runner is spawned
there is no second chance to intervene, so the policy gate's ``call_tool`` wrapper
is the ONLY enforcement window. This module is the scanner it calls there.

It is a **pure, dependency-free, stateless** function modelled on
``core/src/InjectionGuard.cpp``'s weighted-cue design: a table of case-insensitive
regex cues, each with a risk weight, plus a few special-case helpers (rm-of-root,
homograph/lookalike URLs). Scores accumulate; a single high-weight (>=3) cue OR a
total >=3 is ``high``, a total >=2 is ``medium``, anything less is NOT risky.

Calibration goal: **flag only unambiguous destruction/exfiltration** and keep
false positives near zero. Routine dev commands MUST pass clean, e.g.::

    rm -rf /tmp/build        rm -rf ./build          git clean -fdx
    curl https://api.x/v1    curl -s https://api | jq .    docker build -t app .
    dd if=/dev/zero of=./f   echo hi | base64         kill -9 12345

What it flags (unambiguous only):
  - ``rm -rf`` of ``/``, a top-level system dir, ``~``/``$HOME``, ``--no-preserve-root``,
    or a bare unquoted variable root (``$VAR`` / ``$VAR/`` — the classic unset-var wipe)
  - ``mkfs`` / ``wipefs`` / ``dd of=/dev/<disk>`` / redirect to ``/dev/<disk>`` or ``/etc``
  - fork bombs ``:(){ :|:& };:``
  - fetch-piped-to-shell (``curl|wget … | sh/bash``) and ``base64 -d | sh``
  - ``chmod -R 777`` and ``chmod 777`` of an absolute system path
  - ``shutdown`` / ``reboot`` / ``poweroff`` / ``systemctl poweroff|reboot``
  - reverse shells (``nc -e /bin/sh``, ``ncat --exec``, ``/dev/tcp/`` redirs, ``mkfifo|nc``)
  - credential-file exfil (``cat ~/.ssh/id_* | curl/nc``) and cred-file curl uploads
  - homograph / punycode (``xn--``) and lookalike-unicode URLs
  - broad-kill of this repo's protected processes (foot / sway / kwin / jarvisd /
    cindro-sidebar) — the NEVER-broad-kill rule

Escape hatch: set env ``JARVIS_CMD_SCAN=0`` to disable command scanning entirely
(the policy gate skips this module). Any other value (or unset) keeps it on.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# Risk weights (same tiering as InjectionGuard: a single >=HIGH cue, or a total
# >=HIGH, trips 'high'; a total >=MED trips 'medium'; below that is not risky).
_HIGH = 3
_MED = 2
_LOW = 1

# Only ever look at this many characters — a command longer than this is already
# pathological; the cap keeps the regex pass bounded on a huge argument.
# Hard scan cap: the cue table includes patterns with nested [^...]* runs whose
# worst-case backtracking is superlinear — a few KB is plenty to expose any
# real one-liner's intent, and it bounds scan() to milliseconds on adversarial
# megabyte inputs (confirmed multi-second hangs at the old 100k cap).
_MAX_LEN = 8_192

# Top-level system directories whose recursive deletion is catastrophic.
_SYS_DIRS = "etc|usr|bin|sbin|lib|lib64|boot|var|root|sys|proc|dev|opt|home|srv|run"

# This repo's NEVER-broad-kill processes (see AGENTS.md hard rules).
_PROTECTED = "foot|sway|kwin|jarvisd|cindro-sidebar|jarvis-daemon|plasmashell"


@dataclass
class Result:
    """Outcome of a scan. ``severity`` is only meaningful when ``risky``."""

    risky: bool = False
    reason: str = ""            # short label of the highest-weight cue that fired
    cues: list[str] = field(default_factory=list)  # every cue that fired
    severity: str = "medium"    # 'high' | 'medium'

    def as_dict(self) -> dict:
        return {"risky": self.risky, "reason": self.reason,
                "cues": list(self.cues), "severity": self.severity}


# (weight, pattern, label). Patterns are matched case-insensitively. Ordered
# roughly high-signal first; order only affects which cue becomes the `reason`
# among equal-weight hits.
_CUE_SPECS: list[tuple[int, str, str]] = [
    # --- fork bomb ---------------------------------------------------------
    (_HIGH, r":\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*;?\s*\}\s*;\s*:", "fork bomb"),

    # --- filesystem / disk destruction ------------------------------------
    (_HIGH, r"\b(?:mkfs(?:\.\w+)?|wipefs)\b", "filesystem-format command (mkfs/wipefs)"),
    (_HIGH, r"\bdd\b[^\n]*\bof=\s*/dev/(?:sd|hd|nvme|mmcblk|vd|disk|mapper)",
     "dd writing to a raw disk device"),
    (_HIGH, r">\s*/(?:dev/(?:sd|hd|nvme|mmcblk|vd|disk)|etc/|boot/|sys/)",
     "redirect/truncate onto a device or system path"),

    # --- pipe-to-shell (remote code exec) ---------------------------------
    (_HIGH, r"\b(?:curl|wget|fetch)\b.*\|\s*(?:sudo\s+)?"
            r"(?:sh|bash|zsh|dash|ksh|fish|python[0-9.]*|perl|ruby|node)\b",
     "download piped straight into a shell"),
    (_HIGH, r"\bbase64\b.*(?:-d|-D|--decode)\b.*\|\s*(?:sudo\s+)?"
            r"(?:sh|bash|zsh|dash|python[0-9.]*|perl)\b",
     "base64-decoded payload piped into a shell"),

    # --- permission nuking -------------------------------------------------
    (_HIGH, r"\bchmod\b\s+(?:-[a-zA-Z]*R[a-zA-Z]*|--recursive)\s+0?777\b",
     "recursive chmod 777"),
    (_HIGH, r"\bchmod\b\s+0?777\s+/(?:etc|usr|bin|sbin|lib|boot|var|root|sys|proc|dev)?"
            r"(?:/|\s|$|\*)",
     "chmod 777 of an absolute system path"),

    # --- reverse shells ----------------------------------------------------
    (_HIGH, r"\b(?:nc|ncat|netcat)\b[^|;&\n]*-e\s+\S*(?:sh|bash|cmd|powershell)",
     "netcat reverse shell (-e)"),
    (_HIGH, r"\bncat\b[^|;&\n]*(?:--exec|--sh-exec|-c)\b", "ncat exec reverse shell"),
    (_HIGH, r"/dev/(?:tcp|udp)/[\w.$]+/\d", "/dev/tcp reverse shell"),
    (_HIGH, r"\bmkfifo\b.*\|.*\b(?:nc|ncat|netcat)\b", "mkfifo reverse shell"),

    # --- credential exfiltration ------------------------------------------
    (_HIGH, r"\b(?:cat|head|tail|xxd|base64|gpg|dd|cp)\b[^|;&\n]*"
            r"(?:\.ssh/id_|id_rsa|id_ed25519|id_dsa|\.aws/credentials|\.env\b|"
            r"/etc/shadow|\.netrc|\.pgpass|secrets\.json|\.pem\b|private[_-]?key)"
            r"[^|\n]*\|[^|\n]*\b(?:curl|wget|nc|ncat|netcat|socat|scp|ssh)\b",
     "credential file piped to the network (exfiltration)"),
    (_HIGH, r"\b(?:curl|wget)\b[^|;&\n]*(?:-d|--data|-F|--form|-T|--upload-file)"
            r"\s*@?[^\s]*(?:\.ssh/id_|id_rsa|\.aws/credentials|\.env\b|\.netrc|"
            r"\.pem\b|/etc/shadow|\.pgpass)",
     "credential file uploaded via curl/wget"),

    # --- protected processes (NEVER broad-kill) ---------------------------
    (_HIGH, rf"\b(?:pkill|killall)\b[^|;&\n]*\b(?:{_PROTECTED})\b",
     "broad-kill of a protected process (foot/sway/kwin/jarvis)"),
    (_HIGH, rf"\bkill\b[^|;&\n]*\bpgrep\b[^|;&\n]*\b(?:{_PROTECTED})\b",
     "kill $(pgrep) of a protected process"),

    # --- availability / power ---------------------------------------------
    (_MED, r"(?:^|[;&|]\s*|\bsudo\s+|&&\s*)(?:shutdown|reboot|poweroff|halt|init\s+[06])\b",
     "system power-off / reboot"),
    (_MED, r"\bsystemctl\s+(?:poweroff|reboot|halt|suspend|hibernate)\b",
     "systemctl power-off / reboot"),

    # --- phishing URLs -----------------------------------------------------
    (_MED, r"https?://[^\s/'\"<>]*xn--", "punycode (homograph) URL"),

    # --- cover-your-tracks (low; only escalates alongside another cue) -----
    (_LOW, r"\bhistory\s+-c\b", "history cleared"),
    (_LOW, r"(?:unset\s+HISTFILE|HISTFILE=/dev/null)", "shell history disabled"),
]

_CUES: list[tuple[int, "re.Pattern[str]", str]] = [
    # MULTILINE: ^-anchored cues must catch "echo hi\nshutdown -h now" too.
    (w, re.compile(p, re.IGNORECASE | re.MULTILINE), lbl) for (w, p, lbl) in _CUE_SPECS
]

# rm segment + target helpers -------------------------------------------------
_RM_SEG = re.compile(r"\brm\b(.*)", re.IGNORECASE)
_SHORT_FLAG = re.compile(r"-[A-Za-z]+")
_URL = re.compile(r"https?://([^\s/'\"<>]+)", re.IGNORECASE)


def _is_dangerous_root(tok: str) -> bool:
    """True if `tok` is a filesystem root whose recursive delete is catastrophic."""
    t = tok.strip()
    if not t:
        return False
    if re.fullmatch(r"/\*?", t):                          # /  or  /*
        return True
    if re.fullmatch(r"~/?|~/\*", t):                      # ~  or  ~/  or ~/*
        return True
    if re.fullmatch(rf"/(?:{_SYS_DIRS})/?\*?", t):        # /etc, /usr, /var/* ...
        return True
    # A bare variable used as the root: $VAR, ${VAR}, $VAR/, $VAR/* — an unset var
    # collapses this to `/`. We deliberately do NOT flag `$VAR/subdir` (bounded,
    # and `$HOME/.cache/...` is a routine cleanup).
    if re.fullmatch(r"\$\{?\w+\}?/?\*?", t):
        return True
    return False


def _rm_danger(cmd: str) -> str | None:
    """Return a cue label if the command contains a destructive recursive rm."""
    for seg in re.split(r"(?:\n|;|&&|\|\||\||&)", cmd):
        m = _RM_SEG.search(seg)
        if not m:
            continue
        toks = m.group(1).split()
        short = "".join(t[1:] for t in toks if _SHORT_FLAG.fullmatch(t))
        longs = [t for t in toks if t.startswith("--")]
        if "--no-preserve-root" in longs:
            return "rm --no-preserve-root (root deletion)"
        recursive = ("r" in short) or ("R" in short) or ("--recursive" in longs)
        force = ("f" in short) or ("--force" in longs)
        if not (recursive and force):
            continue
        for t in toks:
            if t.startswith("-"):
                continue
            # Strip quotes AND common shell punctuation glued to the token so
            # subshell/group forms like "(rm -rf /)" still expose the root.
            unq = t.replace('"', "").replace("'", "").strip("()`;&{}")
            if _is_dangerous_root(unq):
                return f"rm -rf of a dangerous root ({unq})"
    return None


def _lookalike_url(cmd: str) -> str | None:
    """Flag a URL whose host contains non-ASCII lookalike letters (homograph)."""
    for host in _URL.findall(cmd):
        for ch in host:
            if ord(ch) > 0x7F and ch.isalpha():
                return "lookalike (non-ASCII) characters in URL host"
    return None


def scan(command: str) -> Result:
    """Scan a shell command string. Returns a :class:`Result` (never raises)."""
    if not command:
        return Result()
    text = str(command)
    if not text.strip():
        return Result()
    if len(text) > _MAX_LEN:
        text = text[:_MAX_LEN]

    fired: list[tuple[int, str]] = []
    for weight, rx, label in _CUES:
        if rx.search(text):
            fired.append((weight, label))
    rm = _rm_danger(text)
    if rm:
        fired.append((_HIGH, rm))
    look = _lookalike_url(text)
    if look:
        fired.append((_MED, look))

    if not fired:
        return Result()

    labels = [lbl for _, lbl in fired]
    score = sum(w for w, _ in fired)
    saw_high = any(w >= _HIGH for w, _ in fired)

    if saw_high or score >= _HIGH:
        severity = "high"
    elif score >= _MED:
        severity = "medium"
    else:
        # Only low-signal cues fired (e.g. a lone `history -c`) — not risky.
        return Result(risky=False, reason="", cues=labels, severity="medium")

    # `reason` is the highest-weight cue; ties keep first-fired order (stable sort).
    top = sorted(fired, key=lambda wl: -wl[0])[0][1]
    return Result(risky=True, reason=top, cues=labels, severity=severity)
