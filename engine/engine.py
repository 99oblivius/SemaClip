#!/usr/bin/env python3
"""SemaClip ML engine — IPC entry point.

Communicates with the Deno backend via newline-delimited JSON on stdin/stdout.
Reads commands from stdin, emits events to stdout.

Usage:
    python engine.py --ipc

Protocol (newline-delimited JSON):
    Deno → Engine (stdin):  {"type": "start", "job_id": "...", "vod_path": "...", ...}
                            {"type": "cancel"}
    Engine → Deno (stdout): {"type": "progress", "job_id": "...", "phase": "...", ...}
                            {"type": "clip", "job_id": "...", ...}
                            {"type": "complete", "job_id": "...", "clips_found": N}
                            {"type": "error", "job_id": "...", "message": "..."}
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import signal
from typing import Any

from semaclip.engine import Pipeline, PipelineConfig
from semaclip.config import EngineConfig


def emit(event: dict[str, Any]) -> None:
    """Write a JSON event to stdout, newline-delimited."""
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


def read_command() -> dict[str, Any] | None:
    """Read a JSON command from stdin. Returns None on EOF."""
    line = sys.stdin.readline()
    if not line:
        return None
    return json.loads(line)


def run_ipc() -> None:
    """Main IPC loop — reads commands, runs pipeline, emits events."""
    config = EngineConfig.from_env()
    pipeline = Pipeline(config)

    cancelled = False

    def handle_sigterm(*_: Any) -> None:
        nonlocal cancelled
        cancelled = True

    signal.signal(signal.SIGTERM, handle_sigterm)

    while not cancelled:
        cmd = read_command()
        if cmd is None:
            break

        if cmd.get("type") == "cancel":
            break

        if cmd.get("type") == "start":
            job_id = cmd["jobId"]
            vod_path = cmd["vodPath"]
            chat_path = cmd.get("chatPath")
            job_config = cmd.get("config", {})

            try:
                for event in pipeline.run(
                    job_id=job_id,
                    vod_path=vod_path,
                    chat_path=chat_path,
                    config=PipelineConfig(**job_config) if job_config else PipelineConfig(),
                ):
                    if cancelled:
                        emit({"type": "error", "jobId": job_id, "phase": "cancelled", "message": "Cancelled by user"})
                        break
                    emit(event)
            except Exception as e:
                emit({"type": "error", "jobId": job_id, "phase": "unknown", "message": str(e)})

    sys.exit(0)


def main() -> None:
    parser = argparse.ArgumentParser(description="SemaClip ML engine")
    parser.add_argument("--ipc", action="store_true", help="Run in IPC mode (stdin/stdout JSON)")
    parser.add_argument("--job", type=str, help="Run a single job (for testing)")
    parser.add_argument("--vod", type=str, help="VOD file path")
    parser.add_argument("--chat", type=str, help="Chat file path")
    args = parser.parse_args()

    if args.ipc:
        run_ipc()
    elif args.job and args.vod:
        config = EngineConfig.from_env()
        pipeline = Pipeline(config)
        for event in pipeline.run(
            job_id=args.job,
            vod_path=args.vod,
            chat_path=args.chat,
            config=PipelineConfig(),
        ):
            print(json.dumps(event))
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
