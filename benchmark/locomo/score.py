#!/usr/bin/env python3
"""Summarize OpenViking-style LoCoMo Judge accuracy and diagnostics."""

from __future__ import annotations

import argparse
import json
import re
import string
from collections import Counter, defaultdict
from pathlib import Path
from statistics import mean
from typing import Any

try:
    from nltk.stem import PorterStemmer
except ImportError as error:  # pragma: no cover - exercised by the CLI environment
    raise SystemExit("score.py requires nltk: python3 -m pip install -r requirements.txt") from error


STEMMER = PorterStemmer()
ARTICLES = re.compile(r"\b(a|an|the|and)\b")
CATEGORY_NAMES = {
    1: "multi-hop",
    2: "temporal",
    3: "open-domain",
    4: "single-hop",
}
TOKEN_FIELDS = ("input", "cache_write", "cache_read", "output", "reasoning", "total")
BILLABLE_TOKEN_FIELDS = ("input", "cache_write", "cache_read", "output")


def normalize_answer(value: str) -> str:
    lowered = value.lower().replace(",", "")
    without_punctuation = "".join(char for char in lowered if char not in string.punctuation)
    return " ".join(ARTICLES.sub(" ", without_punctuation).split())


def token_f1(prediction: str, answer: str) -> float:
    predicted = [STEMMER.stem(word) for word in normalize_answer(prediction).split()]
    expected = [STEMMER.stem(word) for word in normalize_answer(answer).split()]
    if not predicted or not expected:
        return float(predicted == expected)
    common = Counter(predicted) & Counter(expected)
    overlap = sum(common.values())
    if overlap == 0:
        return 0.0
    precision = overlap / len(predicted)
    recall = overlap / len(expected)
    return 2 * precision * recall / (precision + recall)


def score_answer(prediction: str, answer: object, category: int) -> float:
    if category == 5:
        lowered = prediction.lower()
        return float("no information available" in lowered or "not mentioned" in lowered)
    expected = str(answer)
    if category == 3:
        expected = expected.split(";", 1)[0].strip()
    if category == 1:
        predictions = [part.strip() for part in prediction.split(",")]
        answers = [part.strip() for part in expected.split(",")]
        return mean(max(token_f1(candidate, target) for candidate in predictions) for target in answers)
    if category in (2, 3, 4):
        return token_f1(prediction, expected)
    raise ValueError(f"unsupported LoCoMo category: {category}")


def empty_tokens() -> dict[str, int]:
    return {field: 0 for field in TOKEN_FIELDS}


def numeric(value: object) -> int:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0 else 0


def dsh_tokens(event: object) -> dict[str, int]:
    if not isinstance(event, dict):
        return empty_tokens()
    nested = event.get("usage")
    usage = nested if isinstance(nested, dict) else event
    tokens = {
        "input": numeric(usage.get("inputTokens")),
        "cache_write": numeric(usage.get("cacheCreationTokens")),
        "cache_read": numeric(usage.get("cacheReadTokens")),
        "output": numeric(usage.get("outputTokens")),
        "reasoning": numeric(usage.get("reasoningTokens")),
        "total": numeric(usage.get("totalTokens")),
    }
    if tokens["total"] == 0:
        tokens["total"] = sum(tokens[field] for field in BILLABLE_TOKEN_FIELDS)
    return tokens


def judge_tokens(event: object) -> dict[str, int]:
    if not isinstance(event, dict):
        return empty_tokens()
    if any(field in event for field in ("inputTokens", "outputTokens", "totalTokens")):
        return dsh_tokens(event)
    details = event.get("completion_tokens_details")
    reasoning = numeric(details.get("reasoning_tokens")) if isinstance(details, dict) else 0
    cache_read = numeric(event.get("prompt_cache_hit_tokens"))
    cache_miss = event.get("prompt_cache_miss_tokens")
    prompt_details = event.get("prompt_tokens_details")
    if cache_read == 0 and isinstance(prompt_details, dict):
        cache_read = numeric(prompt_details.get("cached_tokens"))
    prompt = numeric(event.get("prompt_tokens"))
    ordinary_input = numeric(cache_miss) if cache_miss is not None else max(0, prompt - cache_read)
    tokens = {
        "input": ordinary_input,
        "cache_write": numeric(event.get("prompt_cache_creation_tokens")),
        "cache_read": cache_read,
        "output": numeric(event.get("completion_tokens")),
        "reasoning": numeric(event.get("reasoning_tokens")) or reasoning,
        "total": numeric(event.get("total_tokens")),
    }
    if tokens["total"] == 0:
        tokens["total"] = sum(tokens[field] for field in BILLABLE_TOKEN_FIELDS)
    return tokens


def add_tokens(target: dict[str, int], source: dict[str, int]) -> None:
    for field in TOKEN_FIELDS:
        target[field] += source[field]


def elapsed_summary(values: list[int], item_count: int) -> dict[str, Any]:
    return {
        "total": sum(values),
        "average_per_item": round(sum(values) / item_count, 3) if item_count and len(values) == item_count else None,
        "minimum": min(values) if values else None,
        "maximum": max(values) if values else None,
    }


def phase_pricing(pricing: dict[str, Any] | None, phase: str) -> dict[str, float] | None:
    if pricing is None:
        return None
    merged: dict[str, float] = {}
    for key in ("default", phase):
        value = pricing.get(key)
        if value is None:
            continue
        if not isinstance(value, dict):
            raise ValueError(f"pricing.{key} must be an object")
        for field, rate in value.items():
            if field not in BILLABLE_TOKEN_FIELDS:
                raise ValueError(f"pricing.{key} has unsupported field {field!r}")
            if not isinstance(rate, (int, float)) or isinstance(rate, bool) or rate < 0:
                raise ValueError(f"pricing.{key}.{field} must be a non-negative number")
            merged[field] = float(rate)
    return merged or None


def token_cost(
    tokens: dict[str, int],
    rates: dict[str, float] | None,
    complete: bool,
    calls: int,
) -> float | None:
    if calls == 0 and complete:
        return 0.0
    if not complete or rates is None:
        return None
    if any(tokens[field] > 0 and field not in rates for field in BILLABLE_TOKEN_FIELDS):
        return None
    return round(sum(tokens[field] * rates.get(field, 0) for field in BILLABLE_TOKEN_FIELDS) / 1_000_000, 8)


def phase_summary(
    *,
    item_count: int,
    elapsed: list[int],
    calls: int,
    tokens: dict[str, int],
    complete: bool,
    rates: dict[str, float] | None,
) -> dict[str, Any]:
    return {
        "items": item_count,
        "model_calls": calls,
        "elapsed_ms": elapsed_summary(elapsed, item_count),
        "tokens": tokens,
        "metrics_complete": complete,
        "cost_usd": token_cost(tokens, rates, complete, calls),
    }


def score_records(
    records: list[dict[str, Any]],
    run_meta: dict[str, Any] | None = None,
    pricing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    eligible = [record for record in records if int(record["category"]) != 5]
    excluded = len(records) - len(eligible)
    by_category: dict[int, dict[str, Any]] = defaultdict(
        lambda: {"count": 0, "correct": 0, "wrong": 0, "errors": 0, "ungraded": 0, "f1": []}
    )
    f1_values: list[float] = []
    correct = wrong = errors = ungraded = 0
    qa_elapsed: list[int] = []
    qa_calls = 0
    qa_tokens = empty_tokens()
    qa_complete = True
    judge_elapsed: list[int] = []
    judge_calls = 0
    judge_token_totals = empty_tokens()
    judge_complete = True

    for record in eligible:
        category = int(record["category"])
        score = score_answer(str(record["prediction"]), record.get("answer", ""), category)
        f1_values.append(score)
        category_stats = by_category[category]
        category_stats["count"] += 1
        category_stats["f1"].append(score)
        verdict = str(record.get("judge_result", "")).strip().upper()
        if verdict == "CORRECT":
            correct += 1
            category_stats["correct"] += 1
        elif verdict == "WRONG":
            wrong += 1
            category_stats["wrong"] += 1
        elif verdict == "ERROR":
            errors += 1
            category_stats["errors"] += 1
        else:
            ungraded += 1
            category_stats["ungraded"] += 1

        elapsed = record.get("elapsed_ms")
        if isinstance(elapsed, int) and elapsed >= 0:
            qa_elapsed.append(elapsed)
        else:
            qa_complete = False
        usage = record.get("usage")
        if isinstance(usage, list) and usage:
            qa_calls += len(usage)
            for event in usage:
                add_tokens(qa_tokens, dsh_tokens(event))
        else:
            qa_complete = False

        judged_elapsed = record.get("judge_elapsed_ms")
        judged_calls = record.get("judge_calls")
        judged_usage = record.get("judge_usage")
        if isinstance(judged_elapsed, int) and judged_elapsed >= 0:
            judge_elapsed.append(judged_elapsed)
        else:
            judge_complete = False
        if isinstance(judged_calls, int) and judged_calls >= 1:
            judge_calls += judged_calls
        else:
            judge_complete = False
        if isinstance(judged_usage, dict):
            judged_usage = [judged_usage]
        if isinstance(judged_usage, list) and judged_usage:
            for event in judged_usage:
                add_tokens(judge_token_totals, judge_tokens(event))
            if isinstance(judged_calls, int) and len(judged_usage) != judged_calls:
                judge_complete = False
        else:
            judge_complete = False

    mode = run_meta.get("mode") if isinstance(run_meta, dict) else None
    is_baseline = mode == "baseline"
    legacy_mechanical_ingestion = mode == "dsh-memory"
    has_consolidation = mode in ("dsh-memory", "memory-consolidate")
    ingestion_records = run_meta.get("ingestion") if isinstance(run_meta, dict) else None
    ingestion_items = ingestion_records if isinstance(ingestion_records, list) else []
    ingestion_complete = is_baseline or legacy_mechanical_ingestion or isinstance(ingestion_records, list)
    ingestion_elapsed: list[int] = []
    ingestion_calls = 0
    ingestion_tokens = empty_tokens()
    for item in ingestion_items:
        if not isinstance(item, dict):
            ingestion_complete = False
            continue
        elapsed = item.get("elapsed_ms")
        calls = item.get("model_calls")
        usage = item.get("usage")
        if isinstance(elapsed, int) and elapsed >= 0:
            ingestion_elapsed.append(elapsed)
        else:
            ingestion_complete = False
        if isinstance(calls, int) and calls >= 1:
            ingestion_calls += calls
        else:
            ingestion_complete = False
        if isinstance(usage, list) and usage:
            for event in usage:
                add_tokens(ingestion_tokens, dsh_tokens(event))
        else:
            ingestion_complete = False

    consolidation_records = run_meta.get("consolidation") if isinstance(run_meta, dict) else None
    consolidation_items = consolidation_records if isinstance(consolidation_records, list) else []
    consolidation_complete = is_baseline or isinstance(consolidation_records, list)
    consolidation_elapsed: list[int] = []
    consolidation_calls = 0
    consolidation_tokens = empty_tokens()
    for item in consolidation_items:
        if not isinstance(item, dict):
            consolidation_complete = False
            continue
        elapsed = item.get("elapsed_ms")
        calls = item.get("model_calls")
        usage = item.get("usage")
        if isinstance(elapsed, int) and elapsed >= 0:
            consolidation_elapsed.append(elapsed)
        else:
            consolidation_complete = False
        if isinstance(calls, int) and calls >= 1:
            consolidation_calls += calls
        else:
            consolidation_complete = False
        if isinstance(usage, list) and usage:
            for event in usage:
                add_tokens(consolidation_tokens, dsh_tokens(event))
        else:
            consolidation_complete = False

    count = len(eligible)
    graded = correct + wrong
    category_output: dict[str, Any] = {}
    for category, stats in sorted(by_category.items()):
        category_graded = stats["correct"] + stats["wrong"]
        category_output[str(category)] = {
            "name": CATEGORY_NAMES.get(category, f"category-{category}"),
            "count": stats["count"],
            "graded": category_graded,
            "correct": stats["correct"],
            "wrong": stats["wrong"],
            "errors": stats["errors"],
            "ungraded": stats["ungraded"],
            "accuracy": round(stats["correct"] / category_graded, 6) if category_graded else None,
            "token_f1_aux": round(mean(stats["f1"]), 6),
        }

    phases = {
        "ingestion": phase_summary(
            item_count=len(ingestion_items),
            elapsed=ingestion_elapsed,
            calls=ingestion_calls,
            tokens=ingestion_tokens,
            complete=ingestion_complete,
            rates=phase_pricing(pricing, "ingestion"),
        ),
        "qa": phase_summary(
            item_count=count,
            elapsed=qa_elapsed,
            calls=qa_calls,
            tokens=qa_tokens,
            complete=qa_complete,
            rates=phase_pricing(pricing, "qa"),
        ),
        "consolidation": phase_summary(
            item_count=len(consolidation_items),
            elapsed=consolidation_elapsed,
            calls=consolidation_calls,
            tokens=consolidation_tokens,
            complete=consolidation_complete,
            rates=phase_pricing(pricing, "consolidation"),
        ),
        "judge": phase_summary(
            item_count=count,
            elapsed=judge_elapsed,
            calls=judge_calls,
            tokens=judge_token_totals,
            complete=judge_complete,
            rates=phase_pricing(pricing, "judge"),
        ),
    }
    route = None
    if isinstance(run_meta, dict):
        provider = run_meta.get("provider")
        model = run_meta.get("model")
        if isinstance(provider, str) and isinstance(model, str):
            route = {"provider": provider, "model": model}
    phases["qa"]["route"] = route
    qa_concurrency = run_meta.get("qa_concurrency") if isinstance(run_meta, dict) else None
    qa_wall_elapsed_ms = run_meta.get("qa_wall_elapsed_ms") if isinstance(run_meta, dict) else None
    phases["qa"]["concurrency"] = qa_concurrency if type(qa_concurrency) is int and qa_concurrency >= 1 else None
    phases["qa"]["wall_elapsed_ms"] = (
        qa_wall_elapsed_ms
        if type(qa_wall_elapsed_ms) is int and qa_wall_elapsed_ms >= 0
        else None
    )
    phases["ingestion"]["route"] = route if mode in ("memory", "memory-consolidate") else None
    phases["consolidation"]["route"] = route if has_consolidation else None
    phases["judge"]["models"] = sorted({
        model
        for record in eligible
        if isinstance((model := record.get("judge_model")), str)
    })
    full_tokens = empty_tokens()
    for phase in phases.values():
        add_tokens(full_tokens, phase["tokens"])
    full_complete = all(phase["metrics_complete"] for phase in phases.values())
    phase_costs = [phase["cost_usd"] for phase in phases.values()]
    full_cost = round(sum(phase_costs), 8) if full_complete and all(cost is not None for cost in phase_costs) else None
    return {
        "count": count,
        "excluded_category_5": excluded,
        "graded": graded,
        "correct": correct,
        "wrong": wrong,
        "errors": errors,
        "ungraded": ungraded,
        "accuracy": round(correct / graded, 6) if graded else None,
        "average_qa_elapsed_ms": phases["qa"]["elapsed_ms"]["average_per_item"],
        "by_category": category_output,
        "token_f1_aux": round(mean(f1_values), 6) if f1_values else None,
        "pricing_usd_per_million_tokens": pricing,
        "stages": phases,
        "full_process": {
            "model_calls": sum(phase["model_calls"] for phase in phases.values()),
            "elapsed_ms": sum(phase["elapsed_ms"]["total"] for phase in phases.values()),
            "tokens": full_tokens,
            "metrics_complete": full_complete,
            "cost_usd": full_cost,
        },
    }


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError(f"line {line_number} must be a JSON object")
        records.append(value)
    return records


def read_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def inferred_meta_path(result: Path) -> Path:
    name = result.name
    suffix = ".judged.jsonl" if name.endswith(".judged.jsonl") else ".jsonl"
    stem = name[:-len(suffix)] if name.endswith(suffix) else result.stem
    return result.with_name(f"{stem}.meta.json")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("result", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--run-meta", type=Path)
    parser.add_argument("--pricing", type=Path)
    args = parser.parse_args()
    meta_path = args.run_meta or inferred_meta_path(args.result)
    run_meta = read_object(meta_path) if meta_path.is_file() else None
    pricing = read_object(args.pricing) if args.pricing is not None else None
    summary = score_records(read_jsonl(args.result), run_meta, pricing)
    rendered = json.dumps(summary, ensure_ascii=False, indent=2) + "\n"
    if args.output is None:
        print(rendered, end="")
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
        print(args.output)


if __name__ == "__main__":
    main()
