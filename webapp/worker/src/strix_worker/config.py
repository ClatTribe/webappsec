"""Worker configuration — read from environment, validated at startup."""

from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv


load_dotenv()


@dataclass(frozen=True)
class WorkerConfig:
    supabase_url: str
    supabase_service_role_key: str
    supabase_db_url: str

    default_strix_llm: str | None
    default_llm_api_key: str | None

    strix_image: str
    strix_bin: str

    worker_concurrency: int
    log_level: str

    @classmethod
    def from_env(cls) -> "WorkerConfig":
        required = {
            "SUPABASE_URL": os.environ.get("SUPABASE_URL"),
            "SUPABASE_SERVICE_ROLE_KEY": os.environ.get("SUPABASE_SERVICE_ROLE_KEY"),
            "SUPABASE_DB_URL": os.environ.get("SUPABASE_DB_URL"),
        }
        missing = [k for k, v in required.items() if not v]
        if missing:
            raise RuntimeError(f"Missing required env vars: {', '.join(missing)}")

        return cls(
            supabase_url=required["SUPABASE_URL"],  # type: ignore[arg-type]
            supabase_service_role_key=required["SUPABASE_SERVICE_ROLE_KEY"],  # type: ignore[arg-type]
            supabase_db_url=required["SUPABASE_DB_URL"],  # type: ignore[arg-type]
            default_strix_llm=os.environ.get("STRIX_LLM"),
            default_llm_api_key=os.environ.get("LLM_API_KEY"),
            strix_image=os.environ.get("STRIX_IMAGE", "ghcr.io/usestrix/strix-sandbox:0.1.13"),
            strix_bin=os.environ.get("STRIX_BIN", "strix"),
            worker_concurrency=int(os.environ.get("WORKER_CONCURRENCY", "1")),
            log_level=os.environ.get("LOG_LEVEL", "INFO"),
        )
