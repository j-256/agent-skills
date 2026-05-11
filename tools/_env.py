"""Load .env from repo root into os.environ.

Tiny dependency-free .env parser. Existing os.environ values win; .env
only fills gaps. No-op if .env is missing.

Each harness script imports load_dotenv() at startup before reading
configuration, so configuration can come from either:
- a tracked default in .env.example (copied to .env locally), or
- direct shell export (CI, ad-hoc overrides).
"""
import os
from pathlib import Path


def load_dotenv():
    repo_root = Path(__file__).resolve().parent.parent
    env_path = repo_root / ".env"
    if not env_path.exists():
        return
    for raw in env_path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip()
        if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
            val = val[1:-1]
        if key and key not in os.environ:
            os.environ[key] = val
