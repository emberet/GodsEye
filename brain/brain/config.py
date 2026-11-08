"""Where the brain keeps its data, models and reports: BRAIN_DATA_DIR, outside the repo (default ~/GodsEyeBrainData)."""
import os
from pathlib import Path

DATA_DIR = Path(os.environ.get("BRAIN_DATA_DIR", Path.home() / "GodsEyeBrainData")).expanduser()
EXPORT_DIR = DATA_DIR / "export"
PRIVATE_DIR = DATA_DIR / "private"  # social (X) data: never published anywhere
MODELS_DIR = DATA_DIR / "models"
REPORTS_DIR = DATA_DIR / "reports"
LOGS_DIR = DATA_DIR / "logs"

SERVER = os.environ.get("BRAIN_SERVER", "GodsEye")
SERVER_DB = os.environ.get("BRAIN_SERVER_DB", "/opt/godseye/app/data/godseye.db")
SERVER_BRAIN_DIR = os.environ.get("BRAIN_SERVER_DIR", "/opt/godseye/app/data/brain")


def ensure_dirs() -> None:
    for d in (EXPORT_DIR, PRIVATE_DIR, MODELS_DIR, REPORTS_DIR, LOGS_DIR):
        d.mkdir(parents=True, exist_ok=True)
