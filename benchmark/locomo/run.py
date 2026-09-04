#!/usr/bin/env python3
"""Run one isolated LoCoMo sample through one of three DSH memory conditions."""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import http.cookiejar
import importlib.metadata
import json
import os
import re
import selectors
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, TextIO
from urllib.parse import urlparse

from dataset import dialogue_sessions, load_sample, question_date, questions


HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
STATE_FILENAME = "locomo-run-state.json"
FAILURE_FILENAME = "locomo-run-failure.json"
RUNNER_VERSION = 4
AGENT_POLICY_VERSION = "isolated-memory-read-v2"
AGENT_PATCH = HERE / "agent.patch.yml"
URL_PATTERN = re.compile(r"dsh web: (http://127\.0\.0\.1:\d+/\?token=[^\s)]+)")
QUESTION_PROMPT = """Current date: {current_date}.
Answer the question directly: {question}"""
INGEST_PROMPT = """Treat only the conversation below as historical evidence. Save stable information that may be useful in future conversations, using one atomic Workspace memory batch when possible. Do not answer the speakers, summarize the conversation, or inspect anything outside the provided conversation and Memory Context. When finished, reply only with "Done".

{transcript}"""
INGEST_BLOCKED_FOLLOWUP = """Finish the current memory task now. Preserve all existing memory content. If the necessary memory update already succeeded, do not write again. Reply only with "Done"."""
QA_BLOCKED_FOLLOWUP = """Stop searching and answer now using only evidence already available in this Session. Do not call more tools. If the evidence is insufficient, give the concise best answer."""
INGEST_PROMPT_VERSION = "v2"
MODES = ("baseline", "memory", "memory-consolidate")


class DshRunError(RuntimeError):
    pass


def parse_question_limit(value: str) -> int | None:
    if value.strip().lower() == "all":
        return None
    try:
        limit = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a positive integer or 'all'") from error
    if limit < 1:
        raise argparse.ArgumentTypeError("must be a positive integer or 'all'")
    return limit


def ingest_response_completed(text: str) -> bool:
    return re.search(r"(?:^|\n)\s*done\.?\s*$", text, re.IGNORECASE) is not None


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Accept authentication redirects without loading the Web UI target."""

    def http_error_302(
        self,
        _request: object,
        response: Any,
        _code: int,
        _message: str,
        _headers: object,
    ) -> Any:
        return response

    http_error_301 = http_error_302
    http_error_303 = http_error_302
    http_error_307 = http_error_302
    http_error_308 = http_error_302


class Sandbox:
    def __init__(
        self,
        source_dsh_home: Path,
        keep: bool,
        dsh_command: list[str],
        root: Path | None = None,
    ) -> None:
        self.explicit_root = root is not None
        if root is None:
            self.root = Path(tempfile.mkdtemp(prefix="dsh-locomo-"))
            self.preexisting = False
        else:
            self.root = root.expanduser().resolve()
            if self.root == REPO_ROOT or REPO_ROOT in self.root.parents:
                raise DshRunError(
                    f"--run-dir must be outside the dsh-memory repository: {self.root}"
                )
            self.preexisting = self.root.exists()
            if self.preexisting and not (self.root / STATE_FILENAME).is_file():
                raise DshRunError(
                    f"--run-dir exists but has no {STATE_FILENAME}: {self.root}"
                )
            self.root.mkdir(parents=True, exist_ok=True)
        self.home = self.root / "home"
        self.dsh_home = self.root / "dsh-home"
        self.qa_dsh_home = self.root / "qa-dsh-home"
        self.workspace = self.root / "workspaces" / "locomo"
        self.runtime = self.root / "runtime"
        self.keep = keep or self.explicit_root
        self.dsh_command = dsh_command
        self.corepack_home = source_dsh_home.parent / ".cache" / "node" / "corepack"
        for directory in (self.home, self.dsh_home, self.workspace, self.runtime):
            directory.mkdir(parents=True, exist_ok=True)
        self.sdk_dsh_bin = self._sdk_dsh_bin(dsh_command)
        for name in ("settings.yaml", ".credentials.yaml"):
            source = source_dsh_home / name
            target = self.dsh_home / name
            if source.is_file() and not target.exists():
                shutil.copy2(source, target)

    def _sdk_dsh_bin(self, command: list[str]) -> Path:
        if len(command) == 1:
            return Path(command[0]).resolve()
        wrapper = self.runtime / "dsh-wrapper"
        wrapper.write_text(
            "#!/bin/sh\nexec " + shlex.join(command) + ' "$@"\n',
            encoding="utf-8",
        )
        wrapper.chmod(0o700)
        return wrapper

    @property
    def env(self) -> dict[str, str]:
        values = {
            **os.environ,
            "HOME": str(self.home),
            "DSH_HOME": str(self.dsh_home),
            "COREPACK_DEFAULT_TO_LATEST": "0",
        }
        if "COREPACK_HOME" not in values and self.corepack_home.is_dir():
            values["COREPACK_HOME"] = str(self.corepack_home)
        return values

    def dsh(
        self,
        args: list[str],
        *,
        cwd: Path | None = None,
        extra_env: dict[str, str] | None = None,
        capture: bool = False,
    ) -> subprocess.CompletedProcess[str]:
        env = {**self.env, **(extra_env or {})}
        completed = subprocess.run(
            [*self.dsh_command, *args],
            cwd=cwd or self.runtime,
            env=env,
            text=True,
            stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
            stderr=subprocess.PIPE if capture else None,
            check=False,
        )
        if completed.returncode != 0:
            details = (completed.stderr or completed.stdout or "").strip()
            raise DshRunError(f"DSH command failed ({completed.returncode}): {' '.join(args)}\n{details}")
        return completed

    def initialize_profile(self, profile: str) -> None:
        self.dsh(["--profile", profile, "--dump-default-config"])

    def clone_profile(self, source: str, target: str) -> None:
        source_path = self.dsh_home / "profiles" / source
        target_path = self.dsh_home / "profiles" / target
        shutil.copytree(source_path, target_path)

    def add_bundle(self, profile: str, package: Path) -> None:
        # A bare local directory is linked by dsh/pnpm without repacking the
        # checkout and rerunning this package's prepack checks per sandbox.
        self.dsh(["plugin", "--profile", profile, "add", str(package.resolve())])

    def use_startup_reload(self, profile: str) -> None:
        manifest_path = self.dsh_home / "profiles" / profile / "package.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["dsh"]["profile"]["patchReload"] = "startup"
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    def cleanup(self) -> None:
        if self.keep:
            print(f"Kept sandbox: {self.root}", file=sys.stderr)
        else:
            shutil.rmtree(self.root, ignore_errors=True)

    def preserve(self, error: BaseException) -> None:
        self.keep = True
        failure = {
            "time": datetime.now(timezone.utc).isoformat(),
            "error": {
                "name": type(error).__name__,
                "message": str(error),
            },
        }
        (self.root / FAILURE_FILENAME).write_text(
            json.dumps(failure, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"Failure details: {self.root / FAILURE_FILENAME}", file=sys.stderr)

    def prepare_qa_home(self) -> None:
        if self.qa_dsh_home.exists():
            shutil.rmtree(self.qa_dsh_home)
        self.qa_dsh_home.mkdir(parents=True)
        for name in ("settings.yaml", ".credentials.yaml"):
            source = self.dsh_home / name
            if source.is_file():
                shutil.copy2(source, self.qa_dsh_home / name)
        for profile in ("sdk", "locomo-memory"):
            source = self.dsh_home / "profiles" / profile
            if source.is_dir():
                shutil.copytree(source, self.qa_dsh_home / "profiles" / profile, symlinks=True)
        self.reset_qa_memory()

    def reset_qa_memory(self) -> None:
        target = self.qa_dsh_home / "memory"
        if target.exists():
            shutil.rmtree(target)
        target.mkdir(parents=True)
        source = self.dsh_home / "memory"
        for name in ("GLOBAL.md", "settings.yml"):
            candidate = source / name
            if candidate.is_file():
                shutil.copy2(candidate, target / name)
        workspaces = source / "workspaces"
        if workspaces.is_dir():
            shutil.copytree(workspaces, target / "workspaces")


class MemoryRpc:
    def __init__(self, sandbox: Sandbox, profile: str) -> None:
        self.sandbox = sandbox
        self.profile = profile
        self.process: subprocess.Popen[str] | None = None
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
            NoRedirectHandler(),
        )
        self.origin = ""
        self.logs: list[str] = []

    def __enter__(self) -> "MemoryRpc":
        self.process = subprocess.Popen(
            [*self.sandbox.dsh_command, "--profile", self.profile, "--no-open", "--port", "0"],
            cwd=self.sandbox.runtime,
            env=self.sandbox.env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=1,
        )
        assert self.process.stdout is not None
        selector = selectors.DefaultSelector()
        selector.register(self.process.stdout, selectors.EVENT_READ)
        deadline = time.monotonic() + 30
        authenticated_url: str | None = None
        while time.monotonic() < deadline and authenticated_url is None:
            if self.process.poll() is not None:
                break
            for key, _ in selector.select(timeout=0.2):
                line = key.fileobj.readline()
                if line:
                    self.logs.append(line.rstrip())
                    match = URL_PATTERN.search(line)
                    if match is not None:
                        authenticated_url = match.group(1)
        selector.close()
        if authenticated_url is None:
            remainder = self.process.stdout.read()
            if remainder:
                self.logs.extend(remainder.splitlines())
            self.close()
            raise DshRunError("Web profile did not publish its authenticated loopback URL\n" + "\n".join(self.logs[-30:]))
        parsed = urlparse(authenticated_url)
        self.origin = f"{parsed.scheme}://{parsed.netloc}"
        threading.Thread(target=self._drain_logs, daemon=True).start()
        self._authenticate(authenticated_url, time.monotonic() + 30)
        return self

    def _authenticate(self, authenticated_url: str, deadline: float) -> None:
        last_error = "Web authentication did not complete"
        while time.monotonic() < deadline:
            try:
                self.opener.open(authenticated_url, timeout=10).read()
                return
            except urllib.error.HTTPError as error:
                body = error.read().decode("utf-8", errors="replace").strip()
                last_error = f"HTTP {error.code}: {body or error.reason}"
                if error.code not in (502, 503, 504):
                    break
            except urllib.error.URLError as error:
                last_error = f"connection error: {error.reason}"
            time.sleep(0.2)
        self.close()
        log_suffix = "\n" + "\n".join(self.logs[-30:]) if self.logs else ""
        raise DshRunError(f"Web profile authentication failed: {last_error}{log_suffix}")

    def _drain_logs(self) -> None:
        if self.process is None or self.process.stdout is None:
            return
        for line in self.process.stdout:
            self.logs.append(line.rstrip())
            del self.logs[:-200]

    def call(self, endpoint: str, payload: object) -> Any:
        rpc_id = str(uuid.uuid4())
        body = json.dumps({
            "type": "client-request",
            "rpcId": rpc_id,
            "method": endpoint,
            "payload": payload,
        }).encode("utf-8")
        request = urllib.request.Request(
            f"{self.origin}/memory/{endpoint}",
            data=body,
            headers={"content-type": "application/json", "origin": self.origin},
            method="POST",
        )
        with self.opener.open(request, timeout=600) as response:
            envelope = json.loads(response.read().decode("utf-8"))
        if envelope.get("rpcId") != rpc_id:
            raise DshRunError("Memory RPC returned a mismatched rpcId")
        result = envelope.get("result")
        if not isinstance(result, dict) or result.get("ok") is not True:
            raise DshRunError(f"Memory RPC {endpoint} failed: {json.dumps(result, ensure_ascii=False)}")
        return result.get("value")

    def close(self) -> None:
        if self.process is None or self.process.poll() is not None:
            return
        self.process.terminate()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)

    def __exit__(self, _type: object, _value: object, _traceback: object) -> None:
        self.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compare plain DSH, dsh-memory Auto Memory, or Auto Memory plus consolidation.",
    )
    parser.add_argument(
        "mode",
        choices=MODES,
        help="baseline | memory (online writes only) | memory-consolidate",
    )
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--sample", default="conv-26")
    parser.add_argument(
        "--question-limit",
        type=parse_question_limit,
        default="5",
        help="maximum category 1-4 questions, or 'all' (default: 5)",
    )
    parser.add_argument("--source-dsh-home", type=Path, default=Path.home() / ".dsh")
    parser.add_argument("--dsh-bin", type=Path)
    parser.add_argument("--dsh-source", type=Path)
    parser.add_argument("--run-dir", type=Path)
    parser.add_argument("--memory-package", type=Path, default=REPO_ROOT)
    parser.add_argument("--provider", default=os.environ.get("DSH_PROVIDER", "deepseek-official"))
    parser.add_argument("--model", default=os.environ.get("DSH_MODEL", "deepseek-v4-flash"))
    parser.add_argument("--max-tokens", type=int)
    parser.add_argument(
        "--qa-concurrency",
        type=int,
        default=os.environ.get("LOCOMO_QA_CONCURRENCY", "4"),
        help="maximum concurrent QA Sessions sharing one SDK runtime (default: 4)",
    )
    parser.add_argument("--debug", action="store_true")
    parser.add_argument("--keep-sandbox", action="store_true", default=os.environ.get("KEEP_SANDBOX") == "1")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.max_tokens is not None and args.max_tokens < 1:
        parser.error("--max-tokens must be positive")
    if args.qa_concurrency < 1:
        parser.error("--qa-concurrency must be positive")
    if args.dsh_bin is not None and args.dsh_source is not None:
        parser.error("--dsh-bin and --dsh-source are mutually exclusive")
    return args


def initialize_run_state(
    sandbox: Sandbox,
    *,
    mode: str,
    sample_id: str,
    data_sha256: str,
    provider: str,
    model: str,
    dsh_command: list[str],
    memory_package: Path,
) -> dict[str, Any]:
    expected = {
        "version": RUNNER_VERSION,
        "mode": mode,
        "sample_id": sample_id,
        "data_sha256": data_sha256,
        "provider": provider,
        "model": model,
        "ingest_prompt_version": INGEST_PROMPT_VERSION,
        "agent_policy_version": AGENT_POLICY_VERSION,
        "dsh_command": dsh_command,
        "memory_package": str(memory_package),
    }
    path = sandbox.root / STATE_FILENAME
    if path.is_file():
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise DshRunError(f"Cannot read resume state: {path}") from error
        if not isinstance(state, dict):
            raise DshRunError(f"Resume state must be an object: {path}")
        mismatches = [key for key, value in expected.items() if state.get(key) != value]
        if mismatches:
            raise DshRunError("Resume state does not match: " + ", ".join(mismatches))
        source_session_ids = state.get("source_session_ids")
        if not isinstance(source_session_ids, list) or not all(isinstance(value, str) for value in source_session_ids):
            raise DshRunError(f"Resume state has invalid source_session_ids: {path}")
        for key in ("profiles_prepared", "ingest_started", "ingest_complete"):
            if not isinstance(state.get(key), bool):
                raise DshRunError(f"Resume state has invalid {key}: {path}")
        if state["ingest_complete"] and not state["profiles_prepared"]:
            raise DshRunError(f"Resume state completed ingest before profiles were prepared: {path}")
        if state["ingest_complete"] and mode != "baseline" and not source_session_ids:
            raise DshRunError(f"Resume state has no source Sessions after ingest: {path}")
        ingestion = state.get("ingestion")
        if not isinstance(ingestion, list):
            raise DshRunError(f"Resume state has invalid ingestion: {path}")
        print(f"Resuming sandbox: {sandbox.root}", file=sys.stderr, flush=True)
        return state
    state = {
        **expected,
        "profiles_prepared": False,
        "ingest_started": False,
        "ingest_complete": False,
        "source_session_ids": [],
        "ingestion": [],
    }
    write_run_state(path, state)
    print(f"Created sandbox: {sandbox.root}", file=sys.stderr, flush=True)
    return state


def write_run_state(path: Path, state: dict[str, Any]) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def prepare_memory_profiles(sandbox: Sandbox, memory_package: Path) -> None:
    if not (memory_package / "lib" / "index.mjs").is_file():
        raise DshRunError("dsh-memory is not built; run pnpm run build first")
    sandbox.initialize_profile("sdk")
    sandbox.initialize_profile("web")
    sandbox.add_bundle("sdk", HERE / "agent-guard")
    sandbox.clone_profile("sdk", "locomo-memory")
    sandbox.clone_profile("web", "locomo-web")
    sandbox.add_bundle("locomo-memory", memory_package)
    sandbox.add_bundle("locomo-web", memory_package)
    sandbox.add_bundle("locomo-recorder", HERE / "recorder")
    sandbox.use_startup_reload("locomo-recorder")


def prepare_baseline_profile(sandbox: Sandbox) -> None:
    sandbox.initialize_profile("sdk")
    sandbox.add_bundle("sdk", HERE / "agent-guard")


def ingest_dialogues(
    sandbox: Sandbox,
    sample: dict[str, Any],
    provider: str,
    model: str,
) -> tuple[list[str], list[dict[str, Any]]]:
    session_ids: list[str] = []
    outcomes: list[dict[str, Any]] = []
    dialogues = dialogue_sessions(sample)
    with AgentRunner(
        sandbox,
        "locomo-memory",
        provider,
        model,
        None,
        agent_mode="ingest",
        reasoning_effort="low",
    ) as agent:
        for index, dialogue in enumerate(dialogues, 1):
            session_id = f"session-locomo-{sample['sample_id']}-{index:03d}"
            print(f"[ingest {index}/{len(dialogues)}] start {session_id}", file=sys.stderr, flush=True)
            result = agent.run(
                INGEST_PROMPT.format(transcript=dialogue.transcript),
                session_id,
                blocked_followup=INGEST_BLOCKED_FOLLOWUP,
            )
            if not ingest_response_completed(result["text"]):
                raise DshRunError(
                    f'Ingest Agent "{session_id}" returned unexpected final text: {result["text"]!r}'
                )
            session_ids.append(session_id)
            outcomes.append({
                "session_id": session_id,
                "elapsed_ms": result["elapsed_ms"],
                "model_calls": len(result["usage"]),
                "tool_calls": result["tool_calls"],
                "usage": result["usage"],
                "agent_attempts": result["agent_attempts"],
            })
            print(
                f"[ingest {index}/{len(dialogues)}] completed "
                f"elapsed_ms={result['elapsed_ms']} model_calls={len(result['usage'])} "
                f"tool_calls={len(result['tool_calls'])}",
                file=sys.stderr,
                flush=True,
            )
    return session_ids, outcomes


def consolidate_dialogues(
    sandbox: Sandbox,
    session_ids: list[str],
    provider: str,
    model: str,
    debug: bool,
) -> list[dict[str, Any]]:
    outcomes: list[dict[str, Any]] = []
    with MemoryRpc(sandbox, "locomo-web") as rpc:
        catalog = rpc.call("models/read", {})
        selected = rpc.call("models/select", {
            "provider": provider,
            "model": model,
            "debugEnabled": debug,
            "expectedRevision": catalog["revision"],
        })
        if selected["status"] != "committed":
            raise DshRunError("dsh-memory model selection changed concurrently")
        listing = rpc.call("sessions/list", {})
        available = {item["sessionId"]: item for item in listing["sessions"]}
        for index, session_id in enumerate(session_ids, 1):
            summary = available.get(session_id)
            if summary is None:
                raise DshRunError(f'persisted source Session "{session_id}" was not listed')
            receipt = summary.get("latestReceipt")
            if (
                isinstance(receipt, dict)
                and receipt.get("current") is True
                and receipt.get("state") in ("committed", "no-change")
            ):
                print(
                    f"[consolidate {index}/{len(session_ids)}] skip {session_id}: {receipt['state']}",
                    file=sys.stderr,
                    flush=True,
                )
                outcomes.append({
                    "session_id": session_id,
                    "status": receipt["state"],
                    "reviewId": receipt["reviewId"],
                    "attempt": receipt["attempt"],
                    "skipped": True,
                })
                continue
            if (
                isinstance(receipt, dict)
                and receipt.get("current") is True
                and receipt.get("state") == "invalid-proposal"
            ):
                previous = {
                    "status": receipt["state"],
                    "reviewId": receipt["reviewId"],
                    "attempt": receipt["attempt"],
                    "changeCount": 0,
                }
                worker_id = consolidation_worker_id(previous)
                metrics = inspect_consolidation_metrics(sandbox, [worker_id])[worker_id]
                if metrics.get("finishReason") == "max-tokens":
                    print(
                        f"[consolidate {index}/{len(session_ids)}] ignore {session_id}: "
                        "previous attempt reached max-tokens",
                        file=sys.stderr,
                        flush=True,
                    )
                    outcomes.append({
                        "session_id": session_id,
                        **previous,
                        "ignored": True,
                        "ignore_reason": "max-tokens",
                        "resumed": True,
                    })
                    continue
            if not summary["eligible"]:
                raise DshRunError(f'Source Session "{session_id}" is ineligible: {summary["reason"]}')
            print(
                f"[consolidate {index}/{len(session_ids)}] start {session_id}",
                file=sys.stderr,
                flush=True,
            )
            outcome = rpc.call("sessions/consolidate", {"sessionId": session_id})
            print(
                f"[consolidate {index}/{len(session_ids)}] {outcome['status']} "
                f"attempt={outcome['attempt']} changes={outcome['changeCount']}",
                file=sys.stderr,
                flush=True,
            )
            if outcome["status"] not in ("committed", "no-change"):
                worker_id = consolidation_worker_id(outcome)
                metrics = inspect_consolidation_metrics(sandbox, [worker_id])[worker_id]
                if outcome["status"] == "invalid-proposal" and metrics.get("finishReason") == "max-tokens":
                    print(
                        f"[consolidate {index}/{len(session_ids)}] ignore {session_id}: max-tokens",
                        file=sys.stderr,
                        flush=True,
                    )
                    outcomes.append({
                        "session_id": session_id,
                        **outcome,
                        "ignored": True,
                        "ignore_reason": "max-tokens",
                    })
                    continue
                debug_path = sandbox.dsh_home / "memory" / "debug" / outcome["reviewId"] / (
                    f"attempt-{outcome['attempt']}.jsonl"
                )
                suffix = f"; debug={debug_path}" if outcome.get("debugLoggingEnabled") else ""
                raise DshRunError(
                    f'Consolidation failed for "{session_id}": {outcome["status"]}{suffix}'
                )
            outcomes.append({"session_id": session_id, **outcome})
    return attach_consolidation_metrics(sandbox, outcomes)


def consolidation_worker_id(outcome: dict[str, Any], attempt: int | None = None) -> str:
    review_id = outcome.get("reviewId")
    resolved_attempt = outcome.get("attempt") if attempt is None else attempt
    if not isinstance(review_id, str) or not isinstance(resolved_attempt, int):
        raise DshRunError("consolidation outcome lacks reviewId or attempt")
    return f"session-memory-{review_id}-attempt-{resolved_attempt}"


def inspect_consolidation_metrics(
    sandbox: Sandbox,
    worker_ids: list[str],
) -> dict[str, dict[str, Any]]:
    input_path = sandbox.runtime / "consolidation-metrics-input.json"
    input_path.write_text(
        json.dumps({"sessionIds": worker_ids}, ensure_ascii=False),
        encoding="utf-8",
    )
    completed = sandbox.dsh(
        ["--profile", "locomo-recorder"],
        extra_env={"DSH_LOCOMO_INSPECTION_FILE": str(input_path)},
        capture=True,
    )
    rendered = next((line.strip() for line in reversed(completed.stdout.splitlines()) if line.strip()), "")
    try:
        inspected = json.loads(rendered)
    except json.JSONDecodeError as error:
        raise DshRunError("consolidation metrics inspector returned invalid JSON") from error
    if not isinstance(inspected, list):
        raise DshRunError("consolidation metrics inspector must return an array")
    by_worker: dict[str, dict[str, Any]] = {
        item.get("sessionId"): item
        for item in inspected
        if isinstance(item, dict) and isinstance(item.get("sessionId"), str)
    }
    for worker_id in worker_ids:
        if worker_id not in by_worker:
            raise DshRunError(f'consolidation metrics missing worker Session "{worker_id}"')
    return by_worker


def attach_consolidation_metrics(
    sandbox: Sandbox,
    outcomes: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    worker_ids = [
        consolidation_worker_id(outcome, attempt)
        for outcome in outcomes
        for attempt in range(1, outcome["attempt"] + 1)
    ]
    by_worker = inspect_consolidation_metrics(sandbox, worker_ids)
    enriched: list[dict[str, Any]] = []
    for outcome in outcomes:
        outcome_worker_ids = [
            consolidation_worker_id(outcome, attempt)
            for attempt in range(1, outcome["attempt"] + 1)
        ]
        attempt_metrics = [by_worker[worker_id] for worker_id in outcome_worker_ids]
        elapsed_values = [metrics.get("workerElapsedMs") for metrics in attempt_metrics]
        call_values = [metrics.get("modelCalls") for metrics in attempt_metrics]
        usage_values = [metrics.get("usage") for metrics in attempt_metrics]
        enriched.append({
            **outcome,
            "worker_session_id": outcome_worker_ids[-1],
            "worker_session_ids": outcome_worker_ids,
            "elapsed_ms": sum(elapsed_values) if all(isinstance(value, int) for value in elapsed_values) else None,
            "model_calls": sum(call_values) if all(isinstance(value, int) for value in call_values) else None,
            "usage": [usage for values in usage_values for usage in values]
            if all(isinstance(values, list) for values in usage_values) else None,
            "finish_reason": attempt_metrics[-1].get("finishReason"),
        })
    return enriched


class AgentRunner:
    def __init__(
        self,
        sandbox: Sandbox,
        profile: str,
        provider: str,
        model: str,
        max_tokens: int | None,
        dsh_home: Path | None = None,
        *,
        agent_mode: str,
        reasoning_effort: str | None = None,
    ) -> None:
        try:
            from deepseek_harness import DeepSeekHarness
        except ImportError as error:
            raise DshRunError(
                "deepseek-harness-sdk is required: python3 -m pip install -r requirements.txt"
            ) from error
        runtime_home = dsh_home or sandbox.dsh_home
        self.harness = DeepSeekHarness(
            provider=provider,
            model=model,
            reasoning_effort=reasoning_effort,
            max_tokens=max_tokens,
            cwd=str(sandbox.workspace),
            runtime_cwd=str(sandbox.runtime),
            dsh_home=str(runtime_home),
            profile=profile,
            dsh_bin=str(sandbox.sdk_dsh_bin),
            patches=(str(AGENT_PATCH),),
            env={
                "HOME": str(sandbox.home),
                "DSH_HOME": str(runtime_home),
                "DSH_LOCOMO_AGENT_MODE": agent_mode,
                "COREPACK_DEFAULT_TO_LATEST": "0",
                **({"COREPACK_HOME": str(sandbox.corepack_home)} if sandbox.corepack_home.is_dir() else {}),
            },
        )

    def __enter__(self) -> "AgentRunner":
        self.harness.start()
        return self

    def run(
        self,
        prompt: str,
        session_id: str,
        *,
        blocked_followup: str | None = None,
    ) -> dict[str, Any]:
        started = time.monotonic()
        events: list[dict[str, Any]] = []
        current_prompt = prompt
        for attempt in range(2):
            result = self.harness.run(current_prompt, session_id=session_id)
            events.extend(result.events)
            if result.finish_reason == "completed":
                return {
                    "text": result.final_response.strip(),
                    "finish_reason": result.finish_reason,
                    "elapsed_ms": round((time.monotonic() - started) * 1000),
                    "usage": usage_events(events),
                    "tool_calls": tool_calls(events),
                    "agent_attempts": attempt + 1,
                }
            if result.finish_reason == "blocked" and blocked_followup is not None and attempt == 0:
                print(
                    f'Agent Session "{session_id}" reached its step limit; continuing once',
                    file=sys.stderr,
                    flush=True,
                )
                current_prompt = blocked_followup
                continue
            raise DshRunError(
                f'Agent Session "{session_id}" ended with {result.finish_reason or "no turn/end"}'
            )
        raise AssertionError("unreachable")

    def __exit__(self, _type: object, _value: object, _traceback: object) -> None:
        self.harness.close()


def run_qa_items(
    qa_runner: AgentRunner,
    items: list[dict[str, Any]],
    *,
    sample_id: str,
    mode: str,
    current_date: str,
    concurrency: int,
    stream: TextIO,
) -> int:
    """Run independent QA Sessions concurrently and persist records in dataset order."""
    started = time.monotonic()
    total = len(items)
    if total == 0:
        return 0

    def answer(position: int, item: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        print(f"[qa {position + 1}/{total}] start", file=sys.stderr, flush=True)
        qa = qa_runner.run(
            QUESTION_PROMPT.format(
                current_date=current_date,
                question=item["question"],
            ),
            f"session-locomo-{sample_id}-qa-{item['question_index']:03d}",
            blocked_followup=QA_BLOCKED_FOLLOWUP,
        )
        return position, {
            "sample_id": sample_id,
            "question_index": item["question_index"],
            "mode": mode,
            "question_date": current_date,
            "question": item["question"],
            "answer": item.get("answer", "Not mentioned"),
            "category": item["category"],
            "prediction": qa["text"],
            "finish_reason": qa["finish_reason"],
            "elapsed_ms": qa["elapsed_ms"],
            "tool_calls": qa["tool_calls"],
            "usage": qa["usage"],
            "agent_attempts": qa["agent_attempts"],
        }

    buffered: dict[int, dict[str, Any]] = {}
    next_write = 0
    worker_count = min(concurrency, total)
    executor = ThreadPoolExecutor(max_workers=worker_count, thread_name_prefix="locomo-qa")
    futures: list[Future[tuple[int, dict[str, Any]]]] = []
    try:
        futures = [executor.submit(answer, position, item) for position, item in enumerate(items)]
        for future in as_completed(futures):
            position, record = future.result()
            buffered[position] = record
            print(
                f"[qa {position + 1}/{total}] completed elapsed_ms={record['elapsed_ms']}",
                file=sys.stderr,
                flush=True,
            )
            while next_write in buffered:
                stream.write(json.dumps(buffered.pop(next_write), ensure_ascii=False) + "\n")
                stream.flush()
                next_write += 1
    except BaseException:
        for future in futures:
            future.cancel()
        executor.shutdown(wait=True, cancel_futures=True)
        raise
    else:
        executor.shutdown(wait=True)
    return round((time.monotonic() - started) * 1000)


def usage_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    values: list[dict[str, Any]] = []
    for event in events:
        if event.get("type") != "assistant/chunk":
            continue
        data = event.get("data")
        chunk = data.get("chunk") if isinstance(data, dict) else None
        if isinstance(chunk, dict) and chunk.get("type") == "usage":
            values.append(dict(chunk))
    return values


def tool_calls(events: list[dict[str, Any]]) -> list[str]:
    values: list[str] = []
    for event in events:
        if event.get("type") != "tool/call":
            continue
        data = event.get("data")
        name = data.get("name") if isinstance(data, dict) else None
        if isinstance(name, str):
            values.append(name)
    return values


def output_path(args: argparse.Namespace) -> Path:
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        return args.output
    directory = HERE / ".tmp"
    directory.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return directory / f"{stamp}-{args.mode}-{args.sample}.jsonl"


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def installed_version(distribution: str) -> str | None:
    try:
        return importlib.metadata.version(distribution)
    except importlib.metadata.PackageNotFoundError:
        return None


def resolve_dsh_command(dsh_bin: Path | None, dsh_source: Path | None = None) -> list[str]:
    if dsh_bin is not None:
        resolved = dsh_bin.expanduser().resolve()
        if not resolved.is_file():
            raise DshRunError(f"--dsh-bin does not exist: {resolved}")
        return [str(resolved)]
    if dsh_source is not None:
        source = dsh_source.expanduser().resolve()
        manifest = source / "package.json"
        if not manifest.is_file():
            raise DshRunError(f"--dsh-source does not contain package.json: {source}")
        return ["pnpm", "--silent", "--dir", str(source), "dsh"]
    try:
        from deepseek_harness_runtime import resolve_bundled_launch_args
        command = [str(value) for value in resolve_bundled_launch_args()]
        if command:
            return command
    except ImportError:
        pass
    discovered = shutil.which("dsh")
    if discovered is None:
        raise DshRunError("Cannot find dsh; install deepseek-harness-sdk or supply --dsh-bin")
    return [discovered]


def main() -> None:
    args = parse_args()
    dsh_command = resolve_dsh_command(args.dsh_bin, args.dsh_source)
    sample = load_sample(args.data, args.sample)
    data_sha256 = file_sha256(args.data)
    output = output_path(args)
    memory_package = args.memory_package.resolve()
    sandbox = Sandbox(
        args.source_dsh_home.expanduser().resolve(),
        args.keep_sandbox,
        dsh_command,
        args.run_dir,
    )
    state_path = sandbox.root / STATE_FILENAME
    previous_handlers: dict[int, Any] = {}

    def stop(_signal_number: int, _frame: object) -> None:
        raise KeyboardInterrupt

    for signal_number in (signal.SIGINT, signal.SIGTERM):
        previous_handlers[signal_number] = signal.signal(signal_number, stop)
    try:
        state = initialize_run_state(
            sandbox,
            mode=args.mode,
            sample_id=args.sample,
            data_sha256=data_sha256,
            provider=args.provider,
            model=args.model,
            dsh_command=dsh_command,
            memory_package=memory_package,
        )
        profile = "sdk"
        ingestion: list[dict[str, Any]] = []
        consolidation: list[dict[str, Any]] = []
        if args.mode == "baseline":
            if state.get("profiles_prepared") is not True:
                prepare_baseline_profile(sandbox)
                state["profiles_prepared"] = True
                state["ingest_complete"] = True
                write_run_state(state_path, state)
        else:
            if state.get("profiles_prepared") is not True:
                prepare_memory_profiles(sandbox, memory_package)
                state["profiles_prepared"] = True
                write_run_state(state_path, state)
            if state.get("ingest_complete") is not True:
                if state.get("ingest_started") is True:
                    raise DshRunError(
                        "The previous run stopped during ingest; use a new --run-dir to avoid duplicate Sessions"
                    )
                state["ingest_started"] = True
                write_run_state(state_path, state)
                source_sessions, ingestion = ingest_dialogues(
                    sandbox,
                    sample,
                    args.provider,
                    args.model,
                )
                state["source_session_ids"] = source_sessions
                state["ingestion"] = ingestion
                state["ingest_complete"] = True
                write_run_state(state_path, state)
            else:
                source_sessions = list(state["source_session_ids"])
                ingestion = list(state["ingestion"])
            if args.mode == "memory-consolidate":
                consolidation = consolidate_dialogues(
                    sandbox,
                    source_sessions,
                    args.provider,
                    args.model,
                    args.debug,
                )
            profile = "locomo-memory"
            sandbox.prepare_qa_home()

        with contextlib.ExitStack() as stack:
            qa_dsh_home = sandbox.qa_dsh_home if args.mode != "baseline" else sandbox.dsh_home
            qa_runner = stack.enter_context(AgentRunner(
                sandbox,
                profile,
                args.provider,
                args.model,
                args.max_tokens,
                dsh_home=qa_dsh_home,
                agent_mode="baseline" if args.mode == "baseline" else "qa",
            ))
            qa_items = questions(sample, args.question_limit)
            current_date = question_date(sample)
            with output.open("w", encoding="utf-8") as stream:
                qa_wall_elapsed_ms = run_qa_items(
                    qa_runner,
                    qa_items,
                    sample_id=args.sample,
                    mode=args.mode,
                    current_date=current_date,
                    concurrency=args.qa_concurrency,
                    stream=stream,
                )

        metadata = {
            "mode": args.mode,
            "sample_id": args.sample,
            "question_count": len(questions(sample, args.question_limit)),
            "excluded_categories": [5],
            "question_date": question_date(sample),
            "provider": args.provider,
            "model": args.model,
            "max_tokens": args.max_tokens,
            "qa_concurrency": args.qa_concurrency,
            "qa_wall_elapsed_ms": qa_wall_elapsed_ms,
            "debug": args.debug,
            "ingest_prompt_version": INGEST_PROMPT_VERSION if args.mode != "baseline" else None,
            "runner_version": RUNNER_VERSION,
            "agent_policy_version": AGENT_POLICY_VERSION,
            "agent_patch": str(AGENT_PATCH),
            "profile": profile,
            "sandbox": str(sandbox.root),
            "data": str(args.data.resolve()),
            "data_sha256": data_sha256,
            "deepseek_harness_sdk_version": installed_version("deepseek-harness-sdk"),
            "ingestion": ingestion,
            "consolidation": consolidation,
            "result": str(output),
        }
        output.with_suffix(".meta.json").write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        (sandbox.root / FAILURE_FILENAME).unlink(missing_ok=True)
        print(output)
    except KeyboardInterrupt as error:
        sandbox.preserve(error)
        raise SystemExit(130) from None
    except Exception as error:
        sandbox.preserve(error)
        raise
    finally:
        for signal_number, handler in previous_handlers.items():
            signal.signal(signal_number, handler)
        sandbox.cleanup()


if __name__ == "__main__":
    main()
