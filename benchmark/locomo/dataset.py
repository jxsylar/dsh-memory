"""Small LoCoMo data helpers shared by the runner and scorer."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class DialogueSession:
    key: str
    date_time: str
    transcript: str


def load_sample(path: Path, sample_id: str) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError("LoCoMo data must be a JSON array")
    for candidate in data:
        if isinstance(candidate, dict) and candidate.get("sample_id") == sample_id:
            _validate_sample(candidate)
            return candidate
    raise ValueError(f'LoCoMo sample "{sample_id}" was not found')


def dialogue_sessions(sample: dict[str, Any]) -> list[DialogueSession]:
    conversation = sample["conversation"]
    numbered: list[tuple[int, DialogueSession]] = []
    for key, messages in conversation.items():
        if not key.startswith("session_") or key.endswith("_date_time") or key.endswith("_summary"):
            continue
        suffix = key.removeprefix("session_")
        if not suffix.isdigit() or not isinstance(messages, list):
            continue
        if not messages:
            continue
        date_time = conversation.get(f"{key}_date_time")
        if not isinstance(date_time, str):
            raise ValueError(f"{key}_date_time must be a string")
        lines = [f"Conversation time: {date_time}"]
        for index, message in enumerate(messages):
            if not isinstance(message, dict):
                raise ValueError(f"{key}[{index}] must be an object")
            speaker = message.get("speaker")
            text = message.get("text")
            dialogue_id = message.get("dia_id")
            if not all(isinstance(value, str) for value in (speaker, text, dialogue_id)):
                raise ValueError(f"{key}[{index}] must contain string speaker, text, and dia_id")
            lines.append(f"[{dialogue_id}] {speaker}: {text}")
        numbered.append((int(suffix), DialogueSession(key, date_time, "\n".join(lines))))
    numbered.sort(key=lambda item: item[0])
    if not numbered:
        raise ValueError("LoCoMo sample has no dialogue sessions")
    return [item[1] for item in numbered]


def question_date(sample: dict[str, Any]) -> str:
    """Return the date of the latest non-empty conversation Session."""
    raw = dialogue_sessions(sample)[-1].date_time
    date_part = raw.split(" on ", 1)[-1].strip()
    try:
        return datetime.strptime(date_part, "%d %B, %Y").strftime("%Y-%m-%d")
    except ValueError as error:
        raise ValueError(f"unsupported LoCoMo Session date: {raw!r}") from error


def questions(sample: dict[str, Any], limit: int | None = None) -> list[dict[str, Any]]:
    """Select evaluable questions using OpenViking's category-5 exclusion."""
    selected: list[dict[str, Any]] = []
    for index, value in enumerate(sample["qa"]):
        if str(value.get("category", "")).strip() == "5":
            continue
        selected.append({**value, "question_index": index})
    return selected if limit is None else selected[:limit]


def _validate_sample(sample: dict[str, Any]) -> None:
    if not isinstance(sample.get("conversation"), dict):
        raise ValueError("LoCoMo sample.conversation must be an object")
    qa = sample.get("qa")
    if not isinstance(qa, list):
        raise ValueError("LoCoMo sample.qa must be an array")
    for index, item in enumerate(qa):
        if not isinstance(item, dict):
            raise ValueError(f"LoCoMo sample.qa[{index}] must be an object")
        if not isinstance(item.get("question"), str) or "category" not in item:
            raise ValueError(f"LoCoMo sample.qa[{index}] lacks question or category")
        if str(item.get("category", "")).strip() != "5" and "answer" not in item:
            raise ValueError(f"LoCoMo sample.qa[{index}] lacks answer")
