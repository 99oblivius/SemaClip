"""SemaClip engine configuration."""
from __future__ import annotations

import os
from dataclasses import dataclass, field


@dataclass
class EngineConfig:
    """Engine-wide configuration loaded from environment."""

    gpu_device: int | None = None
    model_cache_dir: str = "~/.semaclip/models"
    whisper_model: str = "large-v3"
    embedder_model: str = "all-MiniLM-L6-v2"
    llm_model: str = "Qwen2.5-7B"
    batch_size: int = 16

    @classmethod
    def from_env(cls) -> "EngineConfig":
        gpu = os.environ.get("CUDA_VISIBLE_DEVICES")
        return cls(
            gpu_device=int(gpu) if gpu is not None else None,
            model_cache_dir=os.environ.get(
                "SEMACLIP_MODEL_CACHE", "~/.semaclip/models"
            ),
        )
