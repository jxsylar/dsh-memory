from __future__ import annotations

import argparse
import io
import asyncio
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dataset import dialogue_sessions, load_sample, question_date, questions  # noqa: E402
import judge as judge_module  # noqa: E402
from judge import OpenAICompatibleClient, grade_record, is_evaluable, parse_judge_response  # noqa: E402
import run as runner  # noqa: E402
from run import (  # noqa: E402
    AgentRunner,
    INGEST_PROMPT,
    attach_consolidation_metrics,
    DshRunError,
    MemoryRpc,
    NoRedirectHandler,
    parse_question_limit,
    Sandbox,
    consolidate_dialogues,
    ingest_dialogues,
    ingest_response_completed,
    initialize_run_state,
    run_qa_items,
    tool_calls,
    usage_events,
)
from score import judge_tokens, normalize_answer, score_answer, score_records, token_f1  # noqa: E402


class DatasetTests(unittest.TestCase):
    def test_loads_and_orders_numbered_sessions(self) -> None:
        fixture = [{
            "sample_id": "conv-test",
            "qa": [
                {"question": "Unknown?", "category": 5},
                {"question": "Where?", "answer": "Paris", "category": 1},
            ],
            "conversation": {
                "speaker_a": "A",
                "speaker_b": "B",
                "session_2_date_time": "10:00 am on 8 May, 2023",
                "session_2": [{"speaker": "B", "dia_id": "D2:1", "text": "Second"}],
                "session_3_date_time": "10:00 am on 9 May, 2023",
                "session_3": [],
                "session_1_summary": "must not enter evidence",
                "session_1_date_time": "9:00 am on 7 May, 2023",
                "session_1": [{"speaker": "A", "dia_id": "D1:1", "text": "First"}],
            },
        }]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "locomo.json"
            path.write_text(json.dumps(fixture), encoding="utf-8")
            sample = load_sample(path, "conv-test")
        sessions = dialogue_sessions(sample)
        self.assertEqual([session.key for session in sessions], ["session_1", "session_2"])
        self.assertEqual(
            sessions[0].transcript,
            "Conversation time: 9:00 am on 7 May, 2023\n[D1:1] A: First",
        )
        self.assertEqual(questions(sample, 1)[0]["answer"], "Paris")
        self.assertEqual(questions(sample, 1)[0]["question_index"], 1)
        self.assertEqual(question_date(sample), "2023-05-08")

    def test_missing_sample_is_explicit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "locomo.json"
            path.write_text("[]", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "was not found"):
                load_sample(path, "conv-missing")


class ScoreTests(unittest.TestCase):
    def test_normalization_matches_locomo_rules(self) -> None:
        self.assertEqual(normalize_answer("The Cats, and a DOG!"), "cats dog")
        self.assertEqual(token_f1("running", "runs"), 1.0)

    def test_categories_follow_official_branching(self) -> None:
        self.assertEqual(score_answer("Paris, London", "London, Paris", 1), 1.0)
        self.assertEqual(score_answer("likely yes", "Likely yes; because X", 3), 1.0)
        self.assertEqual(score_answer("Not mentioned.", "", 5), 1.0)
        self.assertEqual(score_answer("I think it was Paris", "Paris", 5), 0.0)

    def test_judge_usage_separates_cached_input_and_reasoning(self) -> None:
        self.assertEqual(judge_tokens({
            "prompt_tokens": 100,
            "prompt_cache_hit_tokens": 60,
            "prompt_cache_miss_tokens": 40,
            "completion_tokens": 20,
            "reasoning_tokens": 15,
            "total_tokens": 120,
        }), {
            "input": 40,
            "cache_write": 0,
            "cache_read": 60,
            "output": 20,
            "reasoning": 15,
            "total": 120,
        })

    def test_summary_uses_judge_accuracy_and_excludes_adversarial(self) -> None:
        summary = score_records([
            {
                "category": 2,
                "prediction": "Paris",
                "answer": "Paris",
                "judge_result": "CORRECT",
                "judge_elapsed_ms": 80,
                "judge_calls": 1,
                "judge_usage": [{"prompt_tokens": 20, "completion_tokens": 5, "total_tokens": 25}],
                "elapsed_ms": 100,
                "usage": [{"usage": {
                    "inputTokens": 12,
                    "cacheCreationTokens": 2,
                    "cacheReadTokens": 4,
                    "outputTokens": 3,
                    "reasoningTokens": 1,
                    "totalTokens": 21,
                }}],
            },
            {"category": 5, "prediction": "Not mentioned", "answer": ""},
        ], {
            "mode": "memory-consolidate",
            "qa_concurrency": 4,
            "qa_wall_elapsed_ms": 75,
            "ingestion": [{
                "elapsed_ms": 150,
                "model_calls": 1,
                "usage": [
                    {"inputTokens": 20, "outputTokens": 5, "totalTokens": 25},
                ],
            }],
            "consolidation": [{
                "elapsed_ms": 200,
                "model_calls": 2,
                "usage": [
                    {"inputTokens": 30, "outputTokens": 8, "reasoningTokens": 3, "totalTokens": 38},
                    {"inputTokens": 10, "cacheReadTokens": 5, "outputTokens": 4, "totalTokens": 19},
                ],
            }],
        }, {
            "default": {"input": 1, "cache_write": 2, "cache_read": 0.5, "output": 3},
        })
        self.assertEqual(summary["count"], 1)
        self.assertEqual(summary["excluded_category_5"], 1)
        self.assertEqual(summary["accuracy"], 1.0)
        self.assertEqual(summary["token_f1_aux"], 1.0)
        self.assertEqual(summary["by_category"]["2"]["accuracy"], 1.0)
        self.assertEqual(summary["average_qa_elapsed_ms"], 100)
        self.assertEqual(summary["stages"]["qa"]["tokens"], {
            "input": 12,
            "cache_write": 2,
            "cache_read": 4,
            "output": 3,
            "reasoning": 1,
            "total": 21,
        })
        self.assertEqual(summary["stages"]["qa"]["concurrency"], 4)
        self.assertEqual(summary["stages"]["qa"]["wall_elapsed_ms"], 75)
        self.assertEqual(summary["stages"]["ingestion"]["model_calls"], 1)
        self.assertEqual(summary["stages"]["ingestion"]["tokens"]["total"], 25)
        self.assertEqual(summary["stages"]["consolidation"]["model_calls"], 2)
        self.assertEqual(summary["stages"]["consolidation"]["tokens"]["input"], 40)
        self.assertEqual(summary["stages"]["judge"]["tokens"]["total"], 25)
        self.assertEqual(summary["full_process"]["tokens"]["total"], 128)
        self.assertTrue(summary["full_process"]["metrics_complete"])
        self.assertEqual(summary["full_process"]["cost_usd"], 0.0001755)


class JudgeTests(unittest.TestCase):
    def test_uses_macos_ca_when_python_has_no_configured_bundle(self) -> None:
        class CaPath:
            @staticmethod
            def is_file() -> bool:
                return True

            def __str__(self) -> str:
                return "/etc/ssl/cert.pem"

        paths = type("Paths", (), {"cafile": None})()
        context = object()
        with (
            patch.object(judge_module.ssl, "get_default_verify_paths", return_value=paths),
            patch.object(judge_module, "MACOS_SYSTEM_CA", CaPath()),
            patch.object(judge_module.ssl, "create_default_context", return_value=context) as create,
        ):
            self.assertIs(judge_module.create_ssl_context(), context)
        create.assert_called_once_with(cafile="/etc/ssl/cert.pem")

    def test_accepts_base_or_complete_chat_endpoint(self) -> None:
        self.assertEqual(
            OpenAICompatibleClient("https://api.deepseek.com", "key").endpoint,
            "https://api.deepseek.com/chat/completions",
        )
        self.assertEqual(
            OpenAICompatibleClient("https://example.com/v1/chat/completions", "key").endpoint,
            "https://example.com/v1/chat/completions",
        )

    def test_parses_openviking_style_json(self) -> None:
        verdict, reasoning = parse_judge_response(
            'prefix {"is_correct":"correct","reasoning":"same fact"} suffix'
        )
        self.assertEqual(verdict, "CORRECT")
        self.assertEqual(reasoning, "same fact")

    def test_rejects_invalid_verdict_and_category_five(self) -> None:
        with self.assertRaisesRegex(ValueError, "invalid verdict"):
            parse_judge_response('{"is_correct":"MAYBE"}')
        self.assertFalse(is_evaluable({"category": 5}))
        self.assertTrue(is_evaluable({"category": 4}))

    def test_grades_with_deterministic_chat_completion(self) -> None:
        class Client:
            kwargs: dict[str, object] | None = None

            async def complete(self, **kwargs: object) -> dict[str, object]:
                self.kwargs = kwargs
                return {
                    "choices": [{
                        "message": {"content": '{"is_correct":"CORRECT","reasoning":"same"}'},
                    }],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12},
                }

        client = Client()
        graded = asyncio.run(grade_record(
            client,
            {"question": "Where?", "answer": "Paris", "prediction": "Paris"},
            "judge-model",
            0,
        ))
        self.assertEqual(graded["judge_result"], "CORRECT")
        self.assertEqual(graded["judge_usage"][0]["total_tokens"], 12)
        self.assertEqual(graded["judge_calls"], 1)
        self.assertGreaterEqual(graded["judge_elapsed_ms"], 0)
        self.assertEqual(client.kwargs["temperature"], 0)  # type: ignore[index]


class RunnerTests(unittest.TestCase):
    def test_question_limit_accepts_positive_values_or_all(self) -> None:
        self.assertEqual(parse_question_limit("8"), 8)
        self.assertIsNone(parse_question_limit("all"))
        with self.assertRaisesRegex(argparse.ArgumentTypeError, "positive integer or 'all'"):
            parse_question_limit("0")

    def test_ingest_accepts_done_as_the_final_line(self) -> None:
        self.assertTrue(ingest_response_completed("Done."))
        self.assertTrue(ingest_response_completed("Memory updated successfully.\n\nDone."))
        self.assertFalse(ingest_response_completed("Memory updated successfully."))

    def test_agent_continues_once_after_reaching_the_step_limit(self) -> None:
        class Result:
            def __init__(
                self,
                finish_reason: str,
                final_response: str,
                events: list[dict[str, object]],
            ) -> None:
                self.finish_reason = finish_reason
                self.final_response = final_response
                self.events = events

        class Harness:
            calls: list[tuple[str, str]] = []

            def run(self, prompt: str, *, session_id: str) -> Result:
                self.calls.append((prompt, session_id))
                if len(self.calls) == 1:
                    return Result("blocked", "", [
                        {"type": "tool/call", "data": {"name": "read"}},
                        {"type": "assistant/chunk", "data": {
                            "chunk": {"type": "usage", "usage": {"inputTokens": 4}},
                        }},
                    ])
                return Result("completed", "answer", [
                    {"type": "assistant/chunk", "data": {
                        "chunk": {"type": "usage", "usage": {"inputTokens": 2}},
                    }},
                ])

        agent = object.__new__(AgentRunner)
        agent.harness = Harness()
        result = agent.run("question", "session-test", blocked_followup="answer now")

        self.assertEqual(agent.harness.calls, [
            ("question", "session-test"),
            ("answer now", "session-test"),
        ])
        self.assertEqual(result["text"], "answer")
        self.assertEqual(result["agent_attempts"], 2)
        self.assertEqual(result["tool_calls"], ["read"])
        self.assertEqual(len(result["usage"]), 2)

    def test_web_rpc_explicitly_disables_environment_proxies(self) -> None:
        with patch.object(
            urllib.request,
            "getproxies",
            return_value={"http": "http://proxy.invalid:8080"},
        ):
            rpc = MemoryRpc(object(), "fixture")  # type: ignore[arg-type]
        self.assertFalse(any(
            isinstance(handler, urllib.request.ProxyHandler)
            for handler in rpc.opener.handlers
        ))

    def test_web_authentication_redirect_is_not_followed(self) -> None:
        response = object()
        handler = NoRedirectHandler()
        self.assertIs(
            handler.http_error_302(object(), response, 302, "Found", object()),
            response,
        )

    def test_web_authentication_retries_a_startup_bad_gateway(self) -> None:
        class Response:
            def read(self) -> bytes:
                return b"ok"

        class Opener:
            calls = 0

            def open(self, _url: str, timeout: int) -> Response:
                self.calls += 1
                self.assert_timeout(timeout)
                if self.calls == 1:
                    raise urllib.error.HTTPError(
                        "http://127.0.0.1:1234/",
                        502,
                        "Bad Gateway",
                        {},
                        io.BytesIO(b"host is starting"),
                    )
                return Response()

            @staticmethod
            def assert_timeout(timeout: int) -> None:
                if timeout != 10:
                    raise AssertionError(timeout)

        rpc = object.__new__(MemoryRpc)
        rpc.opener = Opener()
        rpc.logs = []
        with patch.object(runner.time, "sleep"):
            rpc._authenticate("http://127.0.0.1:1234/?token=test", float("inf"))
        self.assertEqual(rpc.opener.calls, 2)

    def test_sandbox_copies_only_model_config_and_cleans_all_state(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            source.mkdir()
            (source / "settings.yaml").write_text("model: fixture\n", encoding="utf-8")
            (source / ".credentials.yaml").write_text("secret: fixture\n", encoding="utf-8")
            (source / "sessions").mkdir()
            (source / "sessions" / "old.jsonl").write_text("old", encoding="utf-8")
            sandbox = Sandbox(source, False, ["dsh"])
            root = sandbox.root
            self.assertTrue((sandbox.dsh_home / "settings.yaml").is_file())
            self.assertTrue((sandbox.dsh_home / ".credentials.yaml").is_file())
            self.assertFalse((sandbox.dsh_home / "sessions").exists())
            sandbox.cleanup()
            self.assertFalse(root.exists())

    def test_usage_events_keeps_only_model_usage_chunks(self) -> None:
        events = [
            {"type": "assistant/chunk", "data": {"chunk": {"type": "text", "text": "answer"}}},
            {
                "type": "assistant/chunk",
                "data": {"chunk": {"type": "usage", "usage": {"inputTokens": 12, "outputTokens": 3}}},
            },
            {"type": "turn/end", "data": {"reason": {"kind": "completed"}}},
        ]
        self.assertEqual(usage_events(events), [
            {"type": "usage", "usage": {"inputTokens": 12, "outputTokens": 3}},
        ])

    def test_tool_calls_keeps_only_model_tool_names(self) -> None:
        self.assertEqual(tool_calls([
            {"type": "tool/call", "data": {"name": "memory_update"}},
            {"type": "tool/result", "data": {"name": "memory_update"}},
            {"type": "tool/call", "data": {"name": "read"}},
        ]), ["memory_update", "read"])

    def test_ingest_uses_real_agent_sessions_with_a_small_memory_hint(self) -> None:
        sample = {
            "sample_id": "conv-test",
            "qa": [],
            "conversation": {
                "speaker_a": "A",
                "speaker_b": "B",
                "session_1_date_time": "9:00 am on 7 May, 2023",
                "session_1": [{"speaker": "A", "dia_id": "D1:1", "text": "I like tea."}],
                "session_2_date_time": "9:00 am on 8 May, 2023",
                "session_2": [{"speaker": "B", "dia_id": "D2:1", "text": "I moved to Paris."}],
            },
        }

        class FakeAgent:
            calls: list[tuple[str, str]] = []

            def __init__(self, *_args: object, **kwargs: object) -> None:
                self.kwargs = kwargs

            def __enter__(self) -> "FakeAgent":
                return self

            def __exit__(self, *_args: object) -> None:
                pass

            def run(
                self,
                prompt: str,
                session_id: str,
                **_kwargs: object,
            ) -> dict[str, object]:
                self.calls.append((prompt, session_id))
                return {
                    "text": "Done.",
                    "finish_reason": "completed",
                    "elapsed_ms": 10,
                    "tool_calls": ["memory_update"],
                    "usage": [{"type": "usage", "usage": {"inputTokens": 4}}],
                    "agent_attempts": 1,
                }

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            source.mkdir()
            sandbox = Sandbox(source, False, ["dsh"])
            with patch.object(runner, "AgentRunner", FakeAgent):
                session_ids, outcomes = ingest_dialogues(
                    sandbox,
                    sample,
                    "provider",
                    "model",
                )
            sandbox.cleanup()

        self.assertEqual(session_ids, [
            "session-locomo-conv-test-001",
            "session-locomo-conv-test-002",
        ])
        self.assertEqual(len(outcomes), 2)
        self.assertEqual(outcomes[0]["model_calls"], 1)
        self.assertEqual(outcomes[0]["tool_calls"], ["memory_update"])
        self.assertIn("Save stable information", FakeAgent.calls[0][0])
        self.assertIn("[D1:1] A: I like tea.", FakeAgent.calls[0][0])
        self.assertNotIn("revision", INGEST_PROMPT.lower())

    def test_qa_runs_concurrently_but_writes_dataset_order(self) -> None:
        class FakeAgent:
            lock = threading.Lock()
            barrier = threading.Barrier(2)
            entered = 0
            active = 0
            maximum_active = 0

            def run(
                self,
                prompt: str,
                session_id: str,
                **_kwargs: object,
            ) -> dict[str, object]:
                with self.lock:
                    self.entered += 1
                    ordinal = self.entered
                    self.active += 1
                    self.maximum_active = max(self.maximum_active, self.active)
                if ordinal <= 2:
                    self.barrier.wait(timeout=1)
                with self.lock:
                    self.active -= 1
                return {
                    "text": f"answer for {session_id}",
                    "finish_reason": "completed",
                    "elapsed_ms": 10,
                    "tool_calls": ["read"],
                    "usage": [{"type": "usage", "usage": {"inputTokens": 4}}],
                    "agent_attempts": 1,
                }

        items = [
            {"question_index": 7, "question": "First?", "answer": "A", "category": 1},
            {"question_index": 3, "question": "Second?", "answer": "B", "category": 2},
            {"question_index": 9, "question": "Third?", "answer": "C", "category": 3},
        ]
        stream = io.StringIO()
        agent = FakeAgent()
        wall_elapsed = run_qa_items(
            agent,  # type: ignore[arg-type]
            items,
            sample_id="conv-test",
            mode="memory",
            current_date="2023-05-08",
            concurrency=2,
            stream=stream,
        )
        records = [json.loads(line) for line in stream.getvalue().splitlines()]
        self.assertEqual([record["question_index"] for record in records], [7, 3, 9])
        self.assertEqual(agent.maximum_active, 2)
        self.assertGreaterEqual(wall_elapsed, 0)
        self.assertEqual(records[0]["prediction"], "answer for session-locomo-conv-test-qa-007")

    def test_recorder_profile_disables_live_reload(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            source.mkdir()
            sandbox = Sandbox(source, False, ["dsh"])
            profile = sandbox.dsh_home / "profiles" / "recorder"
            profile.mkdir(parents=True)
            (profile / "package.json").write_text(json.dumps({
                "dsh": {"profile": {"bundles": ["fixture"]}},
            }), encoding="utf-8")
            sandbox.use_startup_reload("recorder")
            manifest = json.loads((profile / "package.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["dsh"]["profile"]["patchReload"], "startup")
            sandbox.cleanup()

    def test_multi_part_dsh_command_gets_an_sdk_executable_wrapper(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            source.mkdir()
            sandbox = Sandbox(source, False, ["pnpm", "--silent", "--dir", "/tmp/dsh source", "dsh"])
            wrapper = sandbox.sdk_dsh_bin
            self.assertTrue(wrapper.is_file())
            self.assertTrue(wrapper.stat().st_mode & 0o100)
            self.assertEqual(
                wrapper.read_text(encoding="utf-8"),
                "#!/bin/sh\nexec pnpm --silent --dir '/tmp/dsh source' dsh \"$@\"\n",
            )
            sandbox.cleanup()

    def test_qa_home_contains_only_profiles_and_authoritative_memory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            source.mkdir()
            (source / "settings.yaml").write_text("model: fixture\n", encoding="utf-8")
            (source / ".credentials.yaml").write_text("secret: fixture\n", encoding="utf-8")
            sandbox = Sandbox(source, False, ["dsh"])
            for profile in ("sdk", "locomo-memory"):
                profile_path = sandbox.dsh_home / "profiles" / profile
                profile_path.mkdir(parents=True)
                (profile_path / "package.json").write_text("{}\n", encoding="utf-8")
            memory = sandbox.dsh_home / "memory"
            workspace = memory / "workspaces" / "fixture"
            workspace.mkdir(parents=True)
            (memory / "GLOBAL.md").write_text("global\n", encoding="utf-8")
            (memory / "settings.yml").write_text("settings\n", encoding="utf-8")
            (workspace / "MEMORY.md").write_text("workspace\n", encoding="utf-8")
            (memory / "reviews").mkdir()
            (memory / "reviews" / "receipt.json").write_text("{}", encoding="utf-8")
            (sandbox.dsh_home / "sessions").mkdir()
            (sandbox.dsh_home / "sessions" / "source.jsonl").write_text("raw", encoding="utf-8")

            sandbox.prepare_qa_home()

            self.assertTrue((sandbox.qa_dsh_home / "profiles" / "sdk" / "package.json").is_file())
            self.assertTrue((sandbox.qa_dsh_home / "profiles" / "locomo-memory" / "package.json").is_file())
            self.assertEqual((sandbox.qa_dsh_home / "memory" / "GLOBAL.md").read_text(), "global\n")
            self.assertEqual(
                (sandbox.qa_dsh_home / "memory" / "workspaces" / "fixture" / "MEMORY.md").read_text(),
                "workspace\n",
            )
            self.assertFalse((sandbox.qa_dsh_home / "sessions").exists())
            self.assertFalse((sandbox.qa_dsh_home / "memory" / "reviews").exists())

            (sandbox.qa_dsh_home / "memory" / "GLOBAL.md").write_text("mutated\n", encoding="utf-8")
            sandbox.reset_qa_memory()
            self.assertEqual((sandbox.qa_dsh_home / "memory" / "GLOBAL.md").read_text(), "global\n")
            sandbox.cleanup()

    def test_preexisting_run_directory_without_state_is_rejected_without_changes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "run"
            source = Path(directory) / "source"
            root.mkdir()
            source.mkdir()
            with self.assertRaisesRegex(DshRunError, "has no locomo-run-state.json"):
                Sandbox(source, False, ["dsh"], root)
            self.assertEqual(list(root.iterdir()), [])

    def test_run_directory_inside_repository_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            source.mkdir()
            with self.assertRaisesRegex(DshRunError, "must be outside the dsh-memory repository"):
                Sandbox(source, False, ["dsh"], ROOT / ".tmp" / "unsafe-run")

    def test_explicit_run_directory_resumes_only_matching_state(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "run"
            source = Path(directory) / "source"
            source.mkdir()
            sandbox = Sandbox(source, False, ["dsh"], root)
            state = initialize_run_state(
                sandbox,
                mode="memory-consolidate",
                sample_id="conv-test",
                data_sha256="abc",
                provider="provider",
                model="model",
                dsh_command=["dsh"],
                memory_package=ROOT,
            )
            state["profiles_prepared"] = True
            runner.write_run_state(root / runner.STATE_FILENAME, state)

            resumed = Sandbox(source, False, ["dsh"], root)
            loaded = initialize_run_state(
                resumed,
                mode="memory-consolidate",
                sample_id="conv-test",
                data_sha256="abc",
                provider="provider",
                model="model",
                dsh_command=["dsh"],
                memory_package=ROOT,
            )
            self.assertTrue(loaded["profiles_prepared"])
            with self.assertRaisesRegex(DshRunError, "does not match: model"):
                initialize_run_state(
                    resumed,
                    mode="memory-consolidate",
                    sample_id="conv-test",
                    data_sha256="abc",
                    provider="provider",
                    model="another-model",
                    dsh_command=["dsh"],
                    memory_package=ROOT,
                )

    def test_consolidation_resume_skips_current_successful_receipts(self) -> None:
        class FakeRpc:
            calls: list[tuple[str, object]] = []

            def __init__(self, _sandbox: Sandbox, _profile: str) -> None:
                pass

            def __enter__(self) -> "FakeRpc":
                return self

            def __exit__(self, *_args: object) -> None:
                pass

            def call(self, endpoint: str, payload: object) -> object:
                self.calls.append((endpoint, payload))
                if endpoint == "models/read":
                    return {"revision": "sha256:settings"}
                if endpoint == "models/select":
                    return {"status": "committed"}
                if endpoint == "sessions/list":
                    return {"sessions": [
                        {
                            "sessionId": "done",
                            "eligible": True,
                            "reason": None,
                            "latestReceipt": {
                                "reviewId": "review-done",
                                "state": "committed",
                                "attempt": 1,
                                "current": True,
                            },
                        },
                        {
                            "sessionId": "retry",
                            "eligible": True,
                            "reason": None,
                            "latestReceipt": {
                                "reviewId": "review-retry",
                                "state": "invalid-proposal",
                                "attempt": 1,
                                "current": True,
                            },
                        },
                    ]}
                if endpoint == "sessions/consolidate":
                    return {
                        "status": "no-change",
                        "recovered": False,
                        "reviewId": "review-retry",
                        "attempt": 2,
                        "changeCount": 0,
                        "debugLoggingEnabled": True,
                    }
                raise AssertionError(endpoint)

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            source.mkdir()
            sandbox = Sandbox(source, False, ["dsh"])
            with (
                patch.object(runner, "MemoryRpc", FakeRpc),
                patch.object(
                    runner,
                    "inspect_consolidation_metrics",
                    return_value={
                        "session-memory-review-retry-attempt-1": {"finishReason": "stop"},
                    },
                ),
                patch.object(runner, "attach_consolidation_metrics", side_effect=lambda _sandbox, values: values),
            ):
                outcomes = consolidate_dialogues(
                    sandbox,
                    ["done", "retry"],
                    "provider",
                    "model",
                    True,
                )
            retried = [payload for endpoint, payload in FakeRpc.calls if endpoint == "sessions/consolidate"]
            self.assertEqual(retried, [{"sessionId": "retry"}])
            self.assertTrue(outcomes[0]["skipped"])
            self.assertEqual(outcomes[1]["attempt"], 2)
            sandbox.cleanup()

    def test_consolidation_ignores_only_max_token_invalid_proposals(self) -> None:
        class FakeRpc:
            def __init__(self, _sandbox: Sandbox, _profile: str) -> None:
                pass

            def __enter__(self) -> "FakeRpc":
                return self

            def __exit__(self, *_args: object) -> None:
                pass

            def call(self, endpoint: str, payload: object) -> object:
                if endpoint == "models/read":
                    return {"revision": "sha256:settings"}
                if endpoint == "models/select":
                    return {"status": "committed"}
                if endpoint == "sessions/list":
                    return {"sessions": [
                        {"sessionId": "truncated", "eligible": True, "reason": None},
                        {"sessionId": "next", "eligible": True, "reason": None},
                    ]}
                if endpoint == "sessions/consolidate" and payload == {"sessionId": "truncated"}:
                    return {
                        "status": "invalid-proposal",
                        "recovered": False,
                        "reviewId": "review-truncated",
                        "attempt": 2,
                        "changeCount": 0,
                        "debugLoggingEnabled": False,
                    }
                if endpoint == "sessions/consolidate" and payload == {"sessionId": "next"}:
                    return {
                        "status": "no-change",
                        "recovered": False,
                        "reviewId": "review-next",
                        "attempt": 1,
                        "changeCount": 0,
                        "debugLoggingEnabled": False,
                    }
                raise AssertionError((endpoint, payload))

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            source.mkdir()
            sandbox = Sandbox(source, False, ["dsh"])
            truncated_worker = "session-memory-review-truncated-attempt-2"
            with (
                patch.object(runner, "MemoryRpc", FakeRpc),
                patch.object(
                    runner,
                    "inspect_consolidation_metrics",
                    return_value={truncated_worker: {"finishReason": "max-tokens"}},
                ),
                patch.object(runner, "attach_consolidation_metrics", side_effect=lambda _sandbox, values: values),
            ):
                outcomes = consolidate_dialogues(
                    sandbox,
                    ["truncated", "next"],
                    "provider",
                    "model",
                    False,
                )
            self.assertEqual(outcomes[0]["status"], "invalid-proposal")
            self.assertTrue(outcomes[0]["ignored"])
            self.assertEqual(outcomes[0]["ignore_reason"], "max-tokens")
            self.assertEqual(outcomes[1]["status"], "no-change")
            sandbox.cleanup()

    def test_consolidation_resume_does_not_retry_previous_max_token_failure(self) -> None:
        class FakeRpc:
            calls: list[str] = []

            def __init__(self, _sandbox: Sandbox, _profile: str) -> None:
                pass

            def __enter__(self) -> "FakeRpc":
                return self

            def __exit__(self, *_args: object) -> None:
                pass

            def call(self, endpoint: str, _payload: object) -> object:
                self.calls.append(endpoint)
                if endpoint == "models/read":
                    return {"revision": "sha256:settings"}
                if endpoint == "models/select":
                    return {"status": "committed"}
                if endpoint == "sessions/list":
                    return {"sessions": [{
                        "sessionId": "truncated",
                        "eligible": True,
                        "reason": None,
                        "latestReceipt": {
                            "reviewId": "review-truncated",
                            "state": "invalid-proposal",
                            "attempt": 2,
                            "current": True,
                        },
                    }]}
                raise AssertionError(endpoint)

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            source.mkdir()
            sandbox = Sandbox(source, False, ["dsh"])
            worker = "session-memory-review-truncated-attempt-2"
            with (
                patch.object(runner, "MemoryRpc", FakeRpc),
                patch.object(
                    runner,
                    "inspect_consolidation_metrics",
                    return_value={worker: {"finishReason": "max-tokens"}},
                ),
                patch.object(runner, "attach_consolidation_metrics", side_effect=lambda _sandbox, values: values),
            ):
                outcomes = consolidate_dialogues(
                    sandbox,
                    ["truncated"],
                    "provider",
                    "model",
                    False,
                )
            self.assertNotIn("sessions/consolidate", FakeRpc.calls)
            self.assertTrue(outcomes[0]["ignored"])
            self.assertTrue(outcomes[0]["resumed"])
            sandbox.cleanup()

    def test_consolidation_does_not_ignore_other_invalid_proposals(self) -> None:
        class FakeRpc:
            def __init__(self, _sandbox: Sandbox, _profile: str) -> None:
                pass

            def __enter__(self) -> "FakeRpc":
                return self

            def __exit__(self, *_args: object) -> None:
                pass

            def call(self, endpoint: str, _payload: object) -> object:
                if endpoint == "models/read":
                    return {"revision": "sha256:settings"}
                if endpoint == "models/select":
                    return {"status": "committed"}
                if endpoint == "sessions/list":
                    return {"sessions": [{"sessionId": "invalid", "eligible": True, "reason": None}]}
                if endpoint == "sessions/consolidate":
                    return {
                        "status": "invalid-proposal",
                        "recovered": False,
                        "reviewId": "review-invalid",
                        "attempt": 1,
                        "changeCount": 0,
                        "debugLoggingEnabled": False,
                    }
                raise AssertionError(endpoint)

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            source.mkdir()
            sandbox = Sandbox(source, False, ["dsh"])
            worker = "session-memory-review-invalid-attempt-1"
            with (
                patch.object(runner, "MemoryRpc", FakeRpc),
                patch.object(
                    runner,
                    "inspect_consolidation_metrics",
                    return_value={worker: {"finishReason": "stop"}},
                ),
            ):
                with self.assertRaisesRegex(DshRunError, "invalid-proposal"):
                    consolidate_dialogues(sandbox, ["invalid"], "provider", "model", False)
            sandbox.cleanup()

    def test_attaches_worker_session_metrics_without_reading_raw_logs(self) -> None:
        class Completed:
            stdout = 'log line\n[' \
                '{"sessionId":"session-memory-review-one-attempt-1",' \
                '"modelCalls":1,"workerElapsedMs":200,"finishReason":"max-tokens",' \
                '"usage":[{"inputTokens":5}]},' \
                '{"sessionId":"session-memory-review-one-attempt-2",' \
                '"modelCalls":2,"workerElapsedMs":450,"finishReason":"stop",' \
                '"usage":[{"inputTokens":10}]}' \
                ']\n'

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            source.mkdir()
            sandbox = Sandbox(source, False, ["dsh"])
            with patch.object(sandbox, "dsh", return_value=Completed()) as dsh:
                enriched = attach_consolidation_metrics(sandbox, [{
                    "session_id": "source",
                    "reviewId": "review-one",
                    "attempt": 2,
                    "status": "committed",
                }])
            self.assertEqual(enriched[0]["worker_session_id"], "session-memory-review-one-attempt-2")
            self.assertEqual(enriched[0]["worker_session_ids"], [
                "session-memory-review-one-attempt-1",
                "session-memory-review-one-attempt-2",
            ])
            self.assertEqual(enriched[0]["elapsed_ms"], 650)
            self.assertEqual(enriched[0]["model_calls"], 3)
            self.assertEqual(enriched[0]["usage"], [{"inputTokens": 5}, {"inputTokens": 10}])
            self.assertEqual(enriched[0]["finish_reason"], "stop")
            self.assertEqual(
                dsh.call_args.kwargs["extra_env"],
                {"DSH_LOCOMO_INSPECTION_FILE": str(sandbox.runtime / "consolidation-metrics-input.json")},
            )
            sandbox.cleanup()


if __name__ == "__main__":
    unittest.main()
