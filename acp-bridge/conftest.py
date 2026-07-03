"""Make the ``acp_bridge`` package importable when tests run against an
interpreter that hasn't ``pip install``-ed this project (e.g. the engine venv).
Having this conftest at the project root also causes pytest to prepend this
directory to sys.path under the default import mode."""

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
