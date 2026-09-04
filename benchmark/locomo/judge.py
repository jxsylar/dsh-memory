#!/usr/bin/env python3
"""Grade LoCoMo answers with an OpenViking-compatible binary LLM judge."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import ssl
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_ENDPOINT = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-chat"
SYSTEM_PROMPT = "You are an expert grader deciding whether an answer matches a gold answer."
JUDGE_PROMPT = """Classify the generated answer as CORRECT or WRONG.

The question asks about facts one participant should know about another from prior conversations. Grade generously: a longer paraphrase is CORRECT when it clearly addresses the same topic as the gold answer without contradiction. For dates and times, accept equivalent formats and relative expressions that identify the same period.

Question: {question}
Gold answer: {answer}
Generated answer: {prediction}

Return JSON only:
{{"is_correct":"CORRECT or WRONG","reasoning":"one short sentence"}}"""
MACOS_SYSTEM_CA = Path("/etc/ssl/cert.pem")


def create_ssl_context() -> ssl.SSLContext:
    """Use Python's configured CA bundle, with the macOS system bundle as fallback."""
    if ssl.get_default_verify_paths().cafile is not None:
        return ssl.create_default_context()
    if MACOS_SYSTEM_CA.is_file():
        return ssl.create_default_context(cafile=str(MACOS_SYSTEM_CA))
    return ssl.create_default_context()


class OpenAICompatibleClient:
    def __init__(self, endpoint: str, api_key: str) -> None:
        normalized = endpoint.rstrip("/")
        self.endpoint = (
            normalized
            if normalized.endswith("/chat/completions")
            else f"{normalized}/chat/completions"
        )
        self.api_key = api_key
        self.ssl_context = create_ssl_context()

    async def complete(
        self,
        *,
        model: str,
        messages: list[dict[str, str]],
        temperature: int,
        timeout: int,
    ) -> dict[str, Any]:
        payload = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
        }
        return await asyncio.to_thread(self._request, payload, timeout)

    def _request(self, payload: dict[str, Any], timeout: int) -> dict[str, Any]:
        request = urllib.request.Request(
            self.endpoint,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(
            request,
            timeout=timeout,
            context=self.ssl_context,
        ) as response:
            value = json.loads(response.read().decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("Judge API response must be a JSON object")
        return value


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--endpoint",
        "--base-url",
        dest="endpoint",
        default=os.environ.get(
            "LOCOMO_JUDGE_ENDPOINT",
            os.environ.get("LOCOMO_JUDGE_BASE_URL", DEFAULT_ENDPOINT),
        ),
    )
    parser.add_argument(
        "--api-key",
        "--token",
        dest="api_key",
        default=os.environ.get(
            "LOCOMO_JUDGE_API_KEY",
            os.environ.get("DEEPSEEK_API_KEY", os.environ.get("OPENAI_API_KEY", "")),
        ),
    )
    parser.add_argument("--model", default=os.environ.get("LOCOMO_JUDGE_MODEL", DEFAULT_MODEL))
    parser.add_argument("--parallel", type=int, default=5)
    parser.add_argument("--retries", type=int, default=2)
    args = parser.parse_args()
    if args.parallel < 1:
        parser.error("--parallel must be positive")
    if args.retries < 0:
        parser.error("--retries must be non-negative")
    if not args.api_key:
        parser.error("--api-key, LOCOMO_JUDGE_API_KEY, DEEPSEEK_API_KEY, or OPENAI_API_KEY is required")
    return args


def output_path(input_path: Path, requested: Path | None) -> Path:
    if requested is not None:
        return requested
    return input_path.with_name(f"{input_path.stem}.judged.jsonl")


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    records: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError(f"{path}:{line_number} must be a JSON object")
        records.append(value)
    return records


def record_key(record: dict[str, Any]) -> tuple[str, int]:
    sample_id = record.get("sample_id")
    question_index = record.get("question_index")
    if not isinstance(sample_id, str) or not isinstance(question_index, int):
        raise ValueError("each record requires string sample_id and integer question_index")
    return sample_id, question_index


def is_evaluable(record: dict[str, Any]) -> bool:
    return str(record.get("category", "")).strip() != "5"


def same_question(left: dict[str, Any], right: dict[str, Any]) -> bool:
    return all(left.get(field) == right.get(field) for field in ("question", "answer", "prediction"))


def parse_judge_response(content: str) -> tuple[str, str]:
    start = content.find("{")
    end = content.rfind("}")
    if start < 0 or end < start:
        raise ValueError(f"Judge returned no JSON object: {content[:200]}")
    value = json.loads(content[start:end + 1])
    if not isinstance(value, dict):
        raise ValueError("Judge response must be a JSON object")
    verdict = str(value.get("is_correct", "")).strip().upper()
    if verdict not in ("CORRECT", "WRONG"):
        raise ValueError(f"Judge returned an invalid verdict: {verdict!r}")
    return verdict, str(value.get("reasoning", "")).strip()


async def grade_record(
    client: Any,
    record: dict[str, Any],
    model: str,
    retries: int,
) -> dict[str, Any]:
    started = time.monotonic()
    error_message = "Judge failed"
    usage_events: list[dict[str, Any]] = []
    calls = 0
    for attempt in range(retries + 1):
        try:
            calls += 1
            response = await client.complete(
                model=model,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": JUDGE_PROMPT.format(
                        question=record["question"],
                        answer=record.get("answer", ""),
                        prediction=record["prediction"],
                    )},
                ],
                temperature=0,
                timeout=60,
            )
            usage = response.get("usage")
            if isinstance(usage, dict):
                usage_events.append(dict(usage))
            choices = response.get("choices")
            if not isinstance(choices, list) or not choices:
                raise ValueError("Judge API response has no choices")
            message = choices[0].get("message") if isinstance(choices[0], dict) else None
            content = message.get("content") if isinstance(message, dict) else None
            if not isinstance(content, str):
                raise ValueError("Judge API response has no message content")
            verdict, reasoning = parse_judge_response(content.strip())
            return {
                **record,
                "judge_result": verdict,
                "judge_reasoning": reasoning,
                "judge_model": model,
                "judge_elapsed_ms": round((time.monotonic() - started) * 1000),
                "judge_calls": calls,
                "judge_usage": usage_events,
            }
        except Exception as error:  # Provider and parse failures are retried uniformly.
            error_message = f"{type(error).__name__}: {error}"
            if attempt < retries:
                await asyncio.sleep(min(2 ** attempt, 5))
    return {
        **record,
        "judge_result": "ERROR",
        "judge_reasoning": "",
        "judge_model": model,
        "judge_elapsed_ms": round((time.monotonic() - started) * 1000),
        "judge_calls": calls,
        "judge_usage": usage_events,
        "judge_error": error_message,
    }


def write_jsonl(path: Path, records: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records),
        encoding="utf-8",
    )
    os.replace(temporary, path)


async def run() -> int:
    args = parse_args()
    destination = output_path(args.input, args.output)
    if destination.resolve() == args.input.resolve():
        raise SystemExit("--output must differ from the raw QA input")

    source = [record for record in read_jsonl(args.input) if is_evaluable(record)]
    source_by_key = {record_key(record): record for record in source}
    if len(source_by_key) != len(source):
        raise ValueError("input contains duplicate sample_id/question_index pairs")

    completed: dict[tuple[str, int], dict[str, Any]] = {}
    for record in read_jsonl(destination):
        key = record_key(record)
        original = source_by_key.get(key)
        if original is None or not same_question(record, original):
            raise ValueError(f"existing Judge output does not match input for {key}")
        if record.get("judge_result") in ("CORRECT", "WRONG"):
            completed[key] = record
    write_jsonl(destination, [completed[key] for key in source_by_key if key in completed])

    pending = [record for record in source if record_key(record) not in completed]
    print(
        f"Judge: total={len(source)} completed={len(completed)} pending={len(pending)}",
        file=sys.stderr,
    )
    client = OpenAICompatibleClient(args.endpoint, args.api_key)
    semaphore = asyncio.Semaphore(args.parallel)
    output_lock = asyncio.Lock()

    async def process(index: int, record: dict[str, Any]) -> None:
        async with semaphore:
            print(
                f"[judge {index}/{len(pending)}] {record['sample_id']} Q{record['question_index']}",
                file=sys.stderr,
                flush=True,
            )
            graded = await grade_record(client, record, args.model, args.retries)
        async with output_lock:
            completed[record_key(record)] = graded
            with destination.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(graded, ensure_ascii=False) + "\n")
                stream.flush()
        print(f"[judge {index}/{len(pending)}] {graded['judge_result']}", file=sys.stderr, flush=True)

    await asyncio.gather(*(process(index, record) for index, record in enumerate(pending, 1)))
    ordered = [completed[record_key(record)] for record in source]
    write_jsonl(destination, ordered)
    correct = sum(record["judge_result"] == "CORRECT" for record in ordered)
    wrong = sum(record["judge_result"] == "WRONG" for record in ordered)
    errors = len(ordered) - correct - wrong
    accuracy = correct / (correct + wrong) if correct + wrong else 0.0
    print(f"Accuracy: {correct}/{correct + wrong} = {accuracy:.2%}; errors={errors}", file=sys.stderr)
    print(destination)
    return 1 if errors else 0


def main() -> None:
    raise SystemExit(asyncio.run(run()))


if __name__ == "__main__":
    main()
