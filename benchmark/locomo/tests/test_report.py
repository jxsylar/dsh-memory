from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from report import ReportError, build_report_data, render_report, safe_script_json  # noqa: E402


MODES = ("baseline", "memory", "memory-consolidate")


def score(mode: str, correct: int) -> dict[str, object]:
    stages = {}
    for stage in ("ingestion", "qa", "consolidation", "judge"):
        stages[stage] = {
            "items": 1,
            "model_calls": 2,
            "elapsed_ms": {"total": 100},
            "tokens": {
                "input": 10,
                "cache_write": 0,
                "cache_read": 5,
                "output": 4,
                "reasoning": 2,
                "total": 19,
            },
            "cost_usd": None,
        }
    return {
        "count": 2,
        "graded": 2,
        "correct": correct,
        "accuracy": correct / 2,
        "by_category": {
            "1": {"graded": 1, "correct": correct > 0},
            "4": {"graded": 1, "correct": correct > 1},
        },
        "stages": stages,
    }


class ReportTests(unittest.TestCase):
    def write_fixture(self, root: Path, *, omit_meta: bool = False) -> None:
        for mode_index, mode in enumerate(MODES):
            mode_root = root / mode
            mode_root.mkdir(parents=True)
            (mode_root / "conv-01-v4-score.json").write_text(
                json.dumps(score(mode, mode_index)), encoding="utf-8"
            )
            if not omit_meta or mode != "memory":
                (mode_root / "conv-01-v4.meta.json").write_text(json.dumps({
                    "provider": "provider",
                    "model": "model",
                    "data_sha256": "abc",
                    "deepseek_harness_sdk_version": "1.0.0",
                    "runner_version": 4,
                    "qa_concurrency": 4,
                }), encoding="utf-8")
            records = [
                {
                    "mode": mode,
                    "sample_id": "conv-01",
                    "question_index": index,
                    "category": 1 if index == 1 else 4,
                    "question": f"Question {index}?",
                    "answer": "Gold",
                    "prediction": "Prediction",
                    "judge_result": "CORRECT" if index <= mode_index else "WRONG",
                    "judge_reasoning": "Reason",
                    "elapsed_ms": 30,
                    "judge_elapsed_ms": 20,
                }
                for index in (1, 2)
            ]
            (mode_root / "conv-01-v4.judged.jsonl").write_text(
                "".join(json.dumps(record) + "\n" for record in records), encoding="utf-8"
            )

    def test_builds_micro_averages_and_compact_details(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_fixture(root)
            data = build_report_data(root, generated_at="2026-09-04T00:00:00+00:00")

        self.assertEqual(data["samples"], ["conv-01"])
        self.assertEqual(data["modes"]["baseline"]["accuracy"], 0)
        self.assertEqual(data["modes"]["memory-consolidate"]["accuracy"], 1)
        self.assertEqual(data["modes"]["memory"]["categories"]["1"]["correct"], 1)
        self.assertEqual(data["modes"]["memory"]["qa_concurrencies"], [4])
        self.assertEqual(len(data["questions"]), 6)
        self.assertNotIn("usage", data["questions"][0])
        self.assertTrue(any(prompt["id"] == "consolidator-system" for prompt in data["prompts"]))

    def test_rejects_incomplete_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_fixture(root, omit_meta=True)
            with self.assertRaisesRegex(ReportError, "missing judged/meta artifact"):
                build_report_data(root)

    def test_report_is_self_contained_and_script_json_is_safe(self) -> None:
        payload = {"text": "</script><b>unsafe</b>"}
        encoded = safe_script_json(payload)
        self.assertNotIn("<", encoded)
        rendered = render_report(payload)
        self.assertIn("<!doctype html>", rendered)
        self.assertNotIn("</script><b>unsafe", rendered)
        self.assertNotIn("https://cdn", rendered)


if __name__ == "__main__":
    unittest.main()
