"""SemaClip engine pipeline — stub implementation.

Emits progress events for each phase, then produces mock clips.
The real ML pipeline will replace the stub methods.
"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Generator, Any

PHASES = [
    "audio_extraction",
    "transcription",
    "chat_parsing",
    "segmentation",
    "embedding",
    "llm_triage",
    "axis_scoring",
    "endpoint_resolution",
    "export_preparation",
]


@dataclass
class PipelineConfig:
    """Per-job pipeline configuration."""
    axis_thresholds: dict[str, float] = field(default_factory=dict)
    max_clips: int = 50


class Pipeline:
    """Orchestrates the ML detection pipeline."""

    def __init__(self, config: Any) -> None:
        self.config = config

    def run(
        self,
        job_id: str,
        vod_path: str,
        chat_path: str | None,
        config: PipelineConfig,
    ) -> Generator[dict[str, Any], None, None]:
        """Run the full pipeline, yielding events."""
        for i, phase in enumerate(PHASES):
            for pct in range(0, 101, 10):
                yield {
                    "type": "progress",
                    "jobId": job_id,
                    "phase": phase,
                    "percent": pct / 100,
                    "message": f"Processing {phase}...",
                }
                time.sleep(0.05)  # simulate work

            # Emit a candidate during axis_scoring
            if phase == "axis_scoring":
                yield {
                    "type": "candidate",
                    "jobId": job_id,
                    "axis": "hype",
                    "start": 120.0,
                    "end": 160.0,
                    "score": 0.87,
                    "signals": {
                        "chatExcitement": 0.9,
                        "voicePitch": 0.6,
                        "emoteVelocity": 0.8,
                        "lurkerActivation": 0.4,
                    },
                }

        # Emit final clips
        clips_found = 0
        for axis, start, end, score in [
            ("hype", 120.0, 160.0, 0.94),
            ("humor", 45.0, 65.0, 0.81),
            ("skill", 200.0, 280.0, 0.88),
        ]:
            yield {
                "type": "clip",
                "jobId": job_id,
                "id": str(uuid.uuid4()),
                "axis": axis,
                "start": start,
                "end": end,
                "peak": (start + end) / 2,
                "score": score,
                "justification": f"Detected {axis} moment with score {score:.2f}",
                "signals": {
                    "chatExcitement": score * 0.9,
                    "voicePitch": score * 0.6,
                    "emoteVelocity": score * 0.8,
                    "lurkerActivation": score * 0.4,
                },
            }
            clips_found += 1

        yield {
            "type": "complete",
            "jobId": job_id,
            "clipsFound": clips_found,
        }
