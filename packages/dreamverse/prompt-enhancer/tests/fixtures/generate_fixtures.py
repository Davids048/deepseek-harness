"""Record reference PromptEnhancer requests and results for the TypeScript replay spec.

Each operation fixture runs one public operation of the Python ``PromptEnhancer`` with the packaged templates, a
real ``ProviderRace``, and a scripted ``VendorClient`` that records every ``ChatRequest`` and returns a fixed reply.
It stores the inputs, the recorded request fields, the result fields (latency excluded), any raised exception, and
the provider success counts.

Each SDK fixture sends one request through the reference ``VendorClient`` and the real Cerebras or OpenAI SDK to a
local HTTP server that answers with scripted responses. It stores the scripted responses, the HTTP requests the SDK
sent (retries included), and the assistant text or the error message. Each race fixture runs ``rewrite_rollout``
through the reference enhancer with both real SDK clients against that server and stores every HTTP request and the
result, including the aggregated provider error.

``prompt-enhancer-fixtures.spec.ts`` replays every fixture from ``fixtures.json``.

Run from the FastVideo checkout root:

    PYTHONPATH=.:apps/dreamverse python \\
        /mnt/lustre/vlm-d1su/codes/fv-hub/deepseek-harness/packages/dreamverse/prompt-enhancer/tests/fixtures/generate_fixtures.py
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import json
import os
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from dreamverse.prompt_enhancement.llm.client import ChatRequest, VendorClient, VendorReply, build_client
from dreamverse.prompt_enhancement.llm.race import ProviderRace
from dreamverse.prompt_enhancement.prompt_enhancer import PromptEnhancer
from dreamverse.prompt_enhancement.settings import PromptSettings
from dreamverse.prompt_enhancement.templates.loader import PromptTemplates

OUTPUT_PATH = Path(__file__).with_name("fixtures.json")
TEMPLATE_KEYS = (
    "auto_system_prompt",
    "enhance_system_prompt",
    "rewrite_all_system_prompt",
    "rewrite_user_system_prompt",
    "ref2va_system_prompt",
)
BASE_SETTINGS = {
    "rewrite_default_model": "gpt-oss-120b",
    "rewrite_model_options": ["gpt-oss-120b", "gpt-alt"],
    "temperature": 1.0,
    "rewrite_default_temperature": 0.7,
    "max_completion_tokens": 3000,
}
LABELS = ["Picture 1", "Picture 2"]


class ScriptedVendor(VendorClient):
    """Record each request and answer with one scripted reply."""

    def __init__(self, reply: dict[str, Any] | None) -> None:
        super().__init__(name="cerebras", request_model="vendor-model", client=None)
        self.reply = reply
        self.requests = []

    async def complete(self, request):
        self.requests.append(request)
        if self.reply is None:
            raise RuntimeError("No scripted reply")
        return VendorReply(text=self.reply["text"], raw_response=self.reply["raw_response"])


def reply(text: str, raw_response: dict[str, Any] | None = None) -> dict[str, Any]:
    """Pair assistant text with the response body a vendor SDK would return for it."""
    return {"text": text, "raw_response": raw_response or {"choices": [{"message": {"content": text}}]}}


EMPTY_LENGTH_REPLY = reply("", {
    "id": "chatcmpl-fixture",
    "choices": [{"index": 0, "finish_reason": "length", "message": {"role": "assistant", "content": None,
                                                                    "refusal": None}}],
    "usage": {"prompt_tokens": 812, "completion_tokens": 3000},
})
EMPTY_LONG_REPLY = reply("", {
    "choices": [{"finish_reason": "content_filter", "message": {"content": [], "annotations": ["Café 猫 🌙" * 30]}}],
    "system_fingerprint": "fp_é\n",
})
LONG_PROSE = ("The model rambled 🌙 about the harbor\n" * 12).strip()

CASES: list[dict[str, Any]] = []


def case(name: str, operation: str, args: dict[str, Any], reply_value: dict[str, Any] | None = None,
         settings: dict[str, Any] | None = None) -> None:
    """Register one operation call; ``args`` uses the Python keyword names plus the positional argument."""
    CASES.append({
        "name": name,
        "operation": operation,
        "settings": {**BASE_SETTINGS, **(settings or {})},
        "args": args,
        "reply": reply_value,
    })


def clip_cases() -> None:
    """Expand one clip across modes, labels, durations, models, and reply formats."""
    for mode in ("t2va", "i2v", "ref2va"):
        for labels in ([], LABELS):
            for duration in (5, 10):
                case(f"clip/{mode}/labels={len(labels)}/{duration}s", "expand_clip", {
                    "conditioning_prompt": "  A forest walk at dawn  ", "segment_duration_sec": duration,
                    "generation_mode": mode, "reference_labels": labels,
                }, reply('{"prompt":"A misty forest path at dawn, birdsong rising."}'))
    for model in (None, "gpt-alt", " gpt-alt ", "unknown-model"):
        case(f"clip/model={model}", "expand_clip", {
            "conditioning_prompt": "A moonbase", "segment_duration_sec": 5, "model": model,
        }, reply('{"prompt":"Detailed moonbase"}'))
    for prompt in ("", "   ", None, 5):
        case(f"clip/blank-input={prompt!r}", "expand_clip", {
            "conditioning_prompt": prompt, "segment_duration_sec": 5,
        }, reply('{"prompt":"unused"}'))
    replies = {
        "unicode": '{"prompt":"  Café scene with 猫 and 🌙 \\u0001 \\"quoted\\"  "}',
        "fenced": 'Here you go:\n```json\n{"prompt": "Fenced clip prompt"}\n```\nEnjoy.',
        "fenced-upper": '```JSON\n{"prompt":"Upper fence"}\n```',
        "fenced-invalid-then-valid": '```json\n{broken\n```\n```\n{"prompt":"second fence"}\n```',
        "prose-wrapped": 'Sure! {"prompt": "Embedded prompt"} Hope this helps.',
        "prose-bad-brace-first": 'Note {not json} then {"prompt": "Second object"}',
        "nested-braces": '{"prompt": "Use {curly} braces \\"}\\" here", "extra": {"a": [1, {"b": "]"}]}}',
        "concatenated": '{"prompt":"first"}{"prompt":"second"}',
        "python-whitespace": '\x1c\x85 {"prompt":"python whitespace"} \x1f',
        "bom": '\ufeff{"prompt":"after bom"}',
        "wrong-field": '{"next_prompt":"wrong field"}',
        "blank-field": '{"prompt":"   "}',
        "list-field": '{"prompt": ["x"]}',
        "array-reply": '["one", "two"]',
        "plain-prose": "plain prose",
        "whitespace-only": "  \n\t ",
        "long-prose": LONG_PROSE,
        "segment-list": '{"segment_prompts":["A","B"]}',
    }
    for label, text in replies.items():
        case(f"clip/reply={label}", "expand_clip", {
            "conditioning_prompt": "An idea", "segment_duration_sec": 5,
        }, reply(text))
    case("clip/reply=empty-length", "expand_clip", {
        "conditioning_prompt": "An idea", "segment_duration_sec": 5,
    }, EMPTY_LENGTH_REPLY)
    case("clip/ref2va-large-budget", "expand_clip", {
        "conditioning_prompt": "An idea", "segment_duration_sec": 5, "generation_mode": "ref2va",
    }, reply('{"prompt":"ok"}'), {"max_completion_tokens": 16384})
    case("clip/edited-default-model", "expand_clip", {
        "conditioning_prompt": "An idea", "segment_duration_sec": 5,
    }, reply('{"prompt":"ok"}'), {"rewrite_default_model": "gpt-alt"})
    case("clip/unsupported-mode", "expand_clip", {
        "conditioning_prompt": "An idea", "segment_duration_sec": 5, "generation_mode": "unsupported-mode",
    }, reply('{"prompt":"unused"}'))


def continuation_cases() -> None:
    """Continue guided and automatic histories across modes, indexes, and reply formats."""
    history = ["A moonbase at night", '  The hatch opens: "hello"\nand closes  ', "", 7, None, "Lights flicker"]
    for mode in ("t2va", "i2v", "ref2va"):
        for labels in ([], LABELS):
            for direction in ("Lights go out", None):
                case(f"continue/{mode}/labels={len(labels)}/direction={direction is not None}", "continue_video", {
                    "conditioning_prompt": direction, "segment_duration_sec": 7, "locked_segments": history,
                    "generation_mode": mode, "reference_labels": labels,
                }, reply('{"next_prompt":"The corridor darkens."}'))
    for locked in (None, [], ["Only one"], [f"Accepted scene {i}" for i in range(1, 8)]):
        for duration in (5, 15):
            case(f"continue/history={None if locked is None else len(locked)}/{duration}s", "continue_video", {
                "conditioning_prompt": None, "segment_duration_sec": duration, "locked_segments": locked,
            }, reply('{"next_prompt":"A door opens."}'))
    for index in (None, 3, 0, -2, 2.5, 12):
        case(f"continue/next-index={index}", "continue_video", {
            "conditioning_prompt": "User direction", "segment_duration_sec": 5,
            "locked_segments": ["One", "Two"], "next_segment_idx": index,
        }, reply('{"next_prompt":"Next."}'))
    for prompt in ("", "   ", 5):
        case(f"continue/blank-direction={prompt!r}", "continue_video", {
            "conditioning_prompt": prompt, "segment_duration_sec": 5, "locked_segments": ["One"],
        }, reply('{"next_prompt":"unused"}'))
    for model in ("gpt-alt", "unknown-model"):
        case(f"continue/model={model}", "continue_video", {
            "conditioning_prompt": None, "segment_duration_sec": 5, "locked_segments": ["One"], "model": model,
        }, reply('{"next_prompt":"ok"}'))
    replies = {
        "fenced": 'Continuation:\n```json\n{"next_prompt": "Fenced next"}\n```',
        "prose-wrapped": 'Here: {"next_prompt": "Embedded next"} done',
        "wrong-field": '{"prompt":"Wrong clip field"}',
        "blank-field": '{"next_prompt":""}',
        "unstructured": "Unstructured prose",
        "long-prose": LONG_PROSE,
    }
    for label, text in replies.items():
        for direction in ("User direction", None):
            case(f"continue/reply={label}/direction={direction is not None}", "continue_video", {
                "conditioning_prompt": direction, "segment_duration_sec": 5, "locked_segments": ["One"],
            }, reply(text))
    case("continue/reply=empty-length", "continue_video", {
        "conditioning_prompt": None, "segment_duration_sec": 5, "locked_segments": ["One"],
    }, EMPTY_LENGTH_REPLY)
    case("continue/unsupported-mode", "continue_video", {
        "conditioning_prompt": None, "segment_duration_sec": 5, "generation_mode": "bogus",
    }, reply('{"next_prompt":"unused"}'))


def rollout_json(count: int, **extra: Any) -> str:
    """Serialize a canonical rollout reply with ``count`` prompts."""
    return json.dumps({**extra, "segment_prompts": [f"Generated segment {i}" for i in range(1, count + 1)]},
                      ensure_ascii=False)


def rollout_cases() -> None:
    """Create and edit rollouts across counts, windows, overrides, metadata, and reply formats."""
    for mode in ("t2va", "i2v", "ref2va"):
        for labels in ([], ["Picture 1"]):
            for count in (1, 3, 6):
                case(f"rollout/new/{mode}/labels={len(labels)}/count={count}", "rewrite_rollout", {
                    "prompts": [], "segment_count": count, "segment_duration_sec": 5,
                    "rewrite_instruction": " A moonbase corridor thriller ", "preset_id": "custom",
                    "preset_label": "Custom rollout", "generation_mode": mode, "reference_labels": labels,
                }, reply(rollout_json(count, id="custom", label="Custom rollout")))
            case(f"rollout/edit/{mode}/labels={len(labels)}", "rewrite_rollout", {
                "prompts": [" prompt one ", "prompt two"], "segment_count": 6, "segment_duration_sec": 10,
                "rewrite_instruction": "cinematic", "generation_mode": mode, "reference_labels": labels,
            }, reply('{"segment_prompts":["A","B"]}'))
    windows = {
        "none": None,
        "empty-list": [],
        "junk-list": ["  ", None, 7],
        "string": "invalid window",
        "dict": {"prompt": "one"},
        "cleaned-window": [" browser one ", "", None, 7, "browser two"],
    }
    for label, window in windows.items():
        for override in (None, "project rewrite template", "  "):
            case(f"rollout/window={label}/override={override!r}", "rewrite_rollout", {
                "prompts": [" stored one ", "stored two", 9, ""], "segment_count": 6, "segment_duration_sec": 5,
                "prompts_to_rewrite": window, "rewrite_instruction": "Make it cinematic",
                "system_prompt_override": override,
            }, reply('{"segment_prompts":["A","B"]}'))
    overrides = [
        (None, None), ("window override", None), (None, "initial override"), ("window override", "initial override"),
        ("window override", "  "), (" window override ", ""), (None, " initial override "),
    ]
    for window_override, initial_override in overrides:
        for mode in ("t2va", "ref2va"):
            case(f"rollout/new-overrides/{window_override!r}/{initial_override!r}/{mode}", "rewrite_rollout", {
                "prompts": [], "segment_count": 3, "segment_duration_sec": 5,
                "prompts_to_rewrite": [" ", None, 7], "rewrite_instruction": "A moonbase thriller",
                "system_prompt_override": window_override, "new_rollout_system_prompt_override": initial_override,
                "generation_mode": mode,
            }, reply(rollout_json(3)))
    for model, temperature in ((None, None), ("gpt-alt", 0.2), (" gpt-alt ", 5), ("unknown", -1), (None, 1.35)):
        case(f"rollout/model={model!r}/temperature={temperature}", "rewrite_rollout", {
            "prompts": ["one", "two"], "segment_count": 6, "segment_duration_sec": 5,
            "rewrite_instruction": "cinematic", "rewrite_model": model, "rewrite_temperature": temperature,
        }, reply('{"segment_prompts":["A","B"]}'))
    for preset_id, preset_label in ((None, None), ("preset_a", "Preset A"), ("  ", "  "), (" padded ", " Label ")):
        for response in ('{"segment_prompts":["A","B"]}', "invalid prose"):
            case(f"rollout/preset={preset_id!r}/{preset_label!r}/reply={response[:8]}", "rewrite_rollout", {
                "prompts": ["one", "two"], "segment_count": 6, "segment_duration_sec": 5,
                "preset_id": preset_id, "preset_label": preset_label, "rewrite_instruction": "cinematic",
            }, reply(response))
    case("rollout/no-source-no-instruction", "rewrite_rollout", {
        "prompts": [], "segment_count": 6, "segment_duration_sec": 5, "rewrite_instruction": "   ",
        "preset_id": " early ", "preset_label": None,
    }, reply(rollout_json(6)))
    for source_count in (1, 3, 7):
        case(f"rollout/source-count={source_count}", "rewrite_rollout", {
            "prompts": [f"Source segment {i}" for i in range(1, source_count + 1)], "segment_count": 3,
            "segment_duration_sec": 5, "rewrite_instruction": "Make the lighting warmer",
        }, reply(json.dumps({"segment_prompts": [f"Rewritten segment {i}" for i in range(1, source_count + 1)]})))

    two = ["one", "two"]
    replies = {
        "canonical": '{"id":"r","label":"Rollout","segment_prompts":[" A ","B"]}',
        "rewritten-prompts": '{"rewritten_prompts":["A","B"]}',
        "segments-objects": '{"segments":[{"prompt":"A"},{"text":"B"}]}',
        "segments-mixed-keys": '{"prompts":[{"segment_prompt":" A "},{"description":"B","prompt":"  "}]}',
        "segments-bad-item": '{"segments":[{"prompt":"A"},{"other":"B"}]}',
        "numbered-prose": "Here are the cinematic prompts:\n1. A\n2. B",
        "numbered-bold": '**Segment 1**: "Opening shot"\ncontinues here\n- **Segment 2:** \'Closing shot\'',
        "numbered-crlf": "Scene_1) First\r\nwith more\r\nScene 2 - Second\u2028tail line",
        "numbered-out-of-range": "1. A\n2. B\n3. C",
        "numbered-missing": "1. A\nand more",
        "nested-rollout": '{"rollout":{"id":"r","label":"Rollout","segment_prompts":["A","B"]}}',
        "nested-current-id-only": '{"current_rollout":{"id":"nested-id","prompts":["A","B"]},"label":"  "}',
        "indexed": '{"segment_1":"A","Segment-2":{"text":"B"}}',
        "indexed-shot-space": '{"shot 2":"B","SCENE1":"A","notes":"ignored"}',
        "indexed-out-of-range": '{"segment_1":"A","segment_2":"B","segment_3":"C"}',
        "indexed-missing": '{"segment_1":"A"}',
        "fenced": 'Rewrite:\n```json\n{"id":"f","label":"Fenced","segment_prompts":["A","B"]}\n```',
        "wrong-count-short": '{"segment_prompts":["A"]}',
        "wrong-count-long": '{"segment_prompts":["A","B","C"]}',
        "empty-item": '{"segment_prompts":["A",""]}',
        "non-string-item": '{"segment_prompts":["A",2]}',
        "blank-label": '{"id":"only-id","label":"  ","segment_prompts":["A","B"]}',
        "invalid-prose": "invalid prose",
        "whitespace-only": "   ",
        "long-prose": LONG_PROSE,
        "array": '["A", "B"]',
    }
    for label, text in replies.items():
        case(f"rollout/reply={label}", "rewrite_rollout", {
            "prompts": two, "segment_count": 6, "segment_duration_sec": 5, "preset_id": "preset_a",
            "preset_label": "Preset A", "rewrite_instruction": "cinematic",
        }, reply(text))
    for label, value in (("empty-length", EMPTY_LENGTH_REPLY), ("empty-long", EMPTY_LONG_REPLY)):
        case(f"rollout/reply={label}", "rewrite_rollout", {
            "prompts": two, "segment_count": 6, "segment_duration_sec": 5, "rewrite_instruction": "cinematic",
        }, value)
    for count in (1, 3, 6):
        for offset in (-1, 1):
            for fmt in ("json-list", "json-indexed", "numbered-prose"):
                prompts = [f"Generated segment {i}" for i in range(1, count + offset + 1)]
                if fmt == "json-list":
                    text = json.dumps({"segment_prompts": prompts})
                elif fmt == "json-indexed":
                    text = json.dumps({f"segment_{i}": p for i, p in enumerate(prompts, 1)})
                else:
                    text = "\n".join(f"{i}. {p}" for i, p in enumerate(prompts, 1))
                case(f"rollout/wrong-count/{count}{offset:+d}/{fmt}", "rewrite_rollout", {
                    "prompts": [], "segment_count": count, "segment_duration_sec": 5,
                    "rewrite_instruction": "A moonbase corridor thriller",
                }, reply(text))
    case("rollout/unsupported-mode", "rewrite_rollout", {
        "prompts": ["A moonbase"], "segment_count": 6, "segment_duration_sec": 5, "generation_mode": "unsupported",
    }, reply('{"segment_prompts":["A"]}'))
    case("rollout/ref2va-large-budget", "rewrite_rollout", {
        "prompts": [], "segment_count": 1, "segment_duration_sec": 5, "rewrite_instruction": "x",
        "generation_mode": "ref2va",
    }, reply(rollout_json(1)), {"max_completion_tokens": 16384})


def build_settings(values: dict[str, Any]) -> PromptSettings:
    """Apply one fixture's request defaults to fresh settings."""
    settings = PromptSettings()
    settings.rewrite_default_model = values["rewrite_default_model"]
    settings.rewrite_model_options = list(values["rewrite_model_options"])
    settings.temperature = values["temperature"]
    settings.rewrite_default_temperature = values["rewrite_default_temperature"]
    settings.max_completion_tokens = values["max_completion_tokens"]
    return settings


def record_request(request: Any, system_prompts: dict[str, str]) -> dict[str, Any]:
    """Keep request fields, naming the packaged template instead of repeating its text."""
    recorded: dict[str, Any] = {}
    template_key = next((key for key, text in system_prompts.items() if text == request.system_prompt), None)
    if template_key is None:
        recorded["system_prompt"] = request.system_prompt
    else:
        recorded["system_prompt_template"] = template_key
    recorded.update({
        "user_content": request.user_content,
        "model": request.model,
        "default_model": request.default_model,
        "temperature": request.temperature,
        "max_completion_tokens": request.max_completion_tokens,
    })
    return recorded


def record_result(result: Any) -> dict[str, Any]:
    """Keep every result field except latency."""
    return {key: value for key, value in vars(result).items() if key != "latency_ms"}


async def run_case(spec: dict[str, Any], templates: PromptTemplates, system_prompts: dict[str, str]) -> dict[str, Any]:
    """Run one fixture through the reference public API and record its observable outputs."""
    vendor = ScriptedVendor(spec["reply"])
    race = ProviderRace([[vendor]], initial_stage_timeout_ms=1500, http_timeout_ms=3000, default_timeout_ms=20000)
    enhancer = PromptEnhancer(build_settings(spec["settings"]), templates, race)
    args = dict(spec["args"])
    if "reference_labels" in args:
        args["reference_labels"] = tuple(args["reference_labels"])
    positional_name = {"expand_clip": "conditioning_prompt", "continue_video": "conditioning_prompt",
                       "rewrite_rollout": "prompts"}[spec["operation"]]
    positional = args.pop(positional_name)
    outcome: dict[str, Any] = {"result": None, "raises": None}
    try:
        result = await getattr(enhancer, spec["operation"])(positional, **args)
        outcome["result"] = record_result(result)
    except ValueError as exc:
        outcome["raises"] = {"type": "ValueError", "message": str(exc)}
    return {
        **spec,
        "requests": [record_request(request, system_prompts) for request in vendor.requests],
        **outcome,
        "provider_success_counts": enhancer.get_provider_success_counts(),
    }


# Scripted HTTP responses per scenario; a request past the end of a script repeats its last response.
def http_json(status: int, body: Any, headers: dict[str, str] | None = None) -> dict[str, Any]:
    """Describe one scripted JSON response."""
    return {"status": status, "headers": {"content-type": "application/json", **(headers or {})},
            "body": json.dumps(body, ensure_ascii=False)}


def http_text(status: int, body: str, headers: dict[str, str] | None = None) -> dict[str, Any]:
    """Describe one scripted text response."""
    return {"status": status, "headers": {"content-type": "text/plain", **(headers or {})}, "body": body}


def http_raw(status: int, body: str, delay_ms: int = 0) -> dict[str, Any]:
    """Describe one scripted JSON response given as exact text, optionally sent after a delay."""
    return {"status": status, "headers": {"content-type": "application/json"}, "body": body, "delay_ms": delay_ms}


OK_BODY = {"id": "chatcmpl-stub", "object": "chat.completion", "created": 1, "model": "vendor-model",
           "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "hello"}}]}
SDK_SCENARIOS: dict[str, list[dict[str, Any]] | None] = {
    "status-500-json": [http_json(500, {"error": {"message": "Internal failure", "type": "server_error", "code": None,
                                                  "retryable": True}})],
    "status-500-text": [http_text(500, "upstream exploded")],
    "status-500-empty": [http_text(500, "")],
    "status-500-blank": [http_text(500, "  \n ")],
    "status-500-json-string": [http_json(500, "oops")],
    "status-500-unicode": [http_json(500, {"error": {"message": "Café 猫 🌙 \n tab\t 'q' \"d\"",
                                                     "detail": {"nested": [None, True, False, 7, 0.5]}}})],
    "status-400-json": [http_json(400, {"error": {"message": "Bad model 'x'", "param": ["model", 1, 0.5, False]}})],
    "status-404-text": [http_text(404, "Not Found")],
    "status-429-retry-after-ms": [http_json(429, {"error": "slow down"}, {"retry-after-ms": "10"})],
    "status-429-long-retry-after": [http_json(429, {"error": "later"}, {"retry-after": "500"})],
    "status-503-should-retry-false": [http_json(503, {"error": "no"}, {"x-should-retry": "false"})],
    "status-400-should-retry-true": [http_json(400, {"error": "again"}, {"x-should-retry": "true",
                                                                         "retry-after-ms": "5"})],
    "status-409-then-ok": [http_json(409, {"error": "conflict"}, {"retry-after-ms": "5"}), http_json(200, OK_BODY)],
    "status-408-retry-after-seconds": [http_text(408, "", {"retry-after": "0.01"})],
    "ok": [http_json(200, OK_BODY)],
    "ok-content-parts": [http_json(200, {"choices": [{"message": {"content": [{"type": "text", "text": "part one "},
                                                                             {"text": {"value": "two"}}]}}]})],
    "connection-refused": None,
    # Response bodies whose SDK model dump the reference embeds in rollout diagnostics.
    "dump-empty-content": [http_raw(200, '{"id": "chatcmpl-stub-9f246f41", "object": "chat.completion", "created": 0, '
                                         '"model": "gpt-oss-120b", "choices": [{"index": 0, "message": {"role": '
                                         '"assistant", "content": ""}, "finish_reason": "stop"}], "usage": '
                                         '{"prompt_tokens": 812, "completion_tokens": 0, "total_tokens": 812}}')],
    "dump-missing-fields": [http_raw(200, '{"choices": [{"message": {"content": "hi"}}]}')],
    "dump-missing-choices": [http_raw(200, '{"id": "only-id"}')],
    "dump-null-message": [http_raw(200, '{"choices": [{"index": 0, "message": null, "finish_reason": "stop"}]}')],
    "dump-extra-fields": [http_raw(200, '{"zzz": 1, "id": "x", "choices": [{"message": {"content": "hi", "weird": '
                                        '[1, 2.5], "role": "assistant"}, "index": 0, "extra_choice": true, '
                                        '"finish_reason": "stop"}], "created": 1.0, "model": "m", "object": '
                                        '"chat.completion", "system_fingerprint": "fp", "time_info": {"queue_time": 1, '
                                        '"total_time": 0.00001, "extra_time": 2}, "usage": {"prompt_tokens": 5.0, '
                                        '"completion_tokens": 1, "total_tokens": 6, "prompt_tokens_details": '
                                        '{"cached_tokens": 0, "extra": "x"}}, "x_groq": {"id": "req_1"}}')],
    "dump-multi-choice": [http_raw(200, '{"id": "multi", "object": "chat.completion", "created": 3, "model": "m", '
                                        '"system_fingerprint": "fp", "choices": [{"index": 0, "message": {"role": '
                                        '"assistant", "content": "first"}, "finish_reason": "stop"}, {"index": 1, '
                                        '"message": {"role": "assistant", "content": null, "tool_calls": [{"id": "t1", '
                                        '"type": "function", "function": {"name": "f", "arguments": "{}"}}]}, '
                                        '"finish_reason": "tool_calls"}, {"index": 2, "message": {"role": "assistant", '
                                        '"content": "third", "refusal": "no"}, "finish_reason": "length"}]}')],
    "dump-cerebras-full": [http_raw(200, '{"id": "chatcmpl-1", "choices": [{"finish_reason": "stop", "index": 0, '
                                         '"message": {"content": "Hello", "role": "assistant"}}], "created": '
                                         '1727000000, "model": "gpt-oss-120b", "system_fingerprint": "fp_abc", '
                                         '"object": "chat.completion", "usage": {"prompt_tokens": 10, '
                                         '"completion_tokens": 5, "total_tokens": 15, "prompt_tokens_details": '
                                         '{"cached_tokens": 0}}, "time_info": {"queue_time": 0.000123, "prompt_time": '
                                         '0.0021, "completion_time": 0.05, "total_time": 0.0525, "created": '
                                         '1727000000.123}}')],
    "dump-openai-full": [http_raw(200, '{"id": "chatcmpl-2", "object": "chat.completion", "created": 1727000001, '
                                       '"model": "openai/gpt-oss-120b", "choices": [{"index": 0, "message": {"role": '
                                       '"assistant", "content": "Hi", "refusal": null, "annotations": []}, '
                                       '"logprobs": {"content": [{"token": "Hi", "logprob": -0.1, "bytes": [72, 105], '
                                       '"top_logprobs": [{"token": "Hi", "logprob": -0.1, "bytes": [72, 105]}]}], '
                                       '"refusal": null}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 9, '
                                       '"completion_tokens": 1, "total_tokens": 10, "prompt_tokens_details": '
                                       '{"cached_tokens": 0, "audio_tokens": 0}, "completion_tokens_details": '
                                       '{"reasoning_tokens": 0, "audio_tokens": 0, "accepted_prediction_tokens": 0, '
                                       '"rejected_prediction_tokens": 0}}, "service_tier": "default", '
                                       '"system_fingerprint": "fp_x", "x_groq": {"id": "req_x", "usage": '
                                       '{"queue_time": 0.01}}}')],
    "dump-type-mismatch": [http_raw(200, '{"id": 7, "created": "123", "object": "chat.completion", "model": "m", '
                                         '"choices": [{"index": "0", "finish_reason": "eos", "message": {"role": '
                                         '"bot", "content": [{"type": "text", "text": "part"}]}, "logprobs": '
                                         '{"content": [{"token": "a", "logprob": -1, "top_logprobs": []}]}}], '
                                         '"usage": {"prompt_tokens": "7", "completion_tokens": true, '
                                         '"total_tokens": 1.5}}')],
    "dump-float-created": [http_raw(200, '{"id": "x", "object": "chat.completion", "created": 1.5e9, "model": "m", '
                                         '"system_fingerprint": "fp", "choices": [{"index": 0, "message": {"role": '
                                         '"assistant", "content": "x"}, "finish_reason": "stop"}], "time_info": '
                                         '{"created": 1727000000}}')],
    "dump-chunk-object": [http_raw(200, '{"id": "c", "object": "chat.completion.chunk", "created": 1, "model": "m", '
                                        '"system_fingerprint": "fp", "choices": [{"index": 0, "delta": {"role": '
                                        '"assistant", "content": "hi"}, "finish_reason": null}]}')],
    "dump-error-chunk": [http_raw(200, '{"error": {"message": "bad", "type": "invalid_request_error", "code": "x"}, '
                                       '"status_code": 400}')],
    "dump-array-body": [http_raw(200, '[1, 2]')],
    "dump-string-body": [http_raw(200, '"hello"')],
}
# Race fixtures give each provider its own script; distinct retry delays fix the order in which providers fail.
RACE_SCENARIOS: dict[str, list[dict[str, Any]]] = {
    "race-500-json-fast": [http_json(500, {"error": {"message": "Internal failure", "type": "server_error"}},
                                     {"retry-after-ms": "1"})],
    "race-500-json-slow": [http_json(500, {"error": {"message": "Overloaded", "code": None}}, {"retry-after-ms": "60"})],
    "race-500-text-fast": [http_text(500, "upstream exploded", {"retry-after-ms": "1"})],
    "race-502-text-slow": [http_text(502, "<html>Bad Gateway</html>", {"retry-after-ms": "60"})],
    "race-empty-content-delayed": [http_raw(200, '{"id": "chatcmpl-stub-9f246f41", "object": "chat.completion", '
                                                 '"created": 0, "model": "gpt-oss-120b", "choices": [{"index": 0, '
                                                 '"message": {"role": "assistant", "content": ""}, "finish_reason": '
                                                 '"stop"}], "usage": {"prompt_tokens": 812, "completion_tokens": 0, '
                                                 '"total_tokens": 812}}', delay_ms=150)],
    "race-ok-after-500": [http_json(500, {"error": "retry me"}, {"retry-after-ms": "1"}),
                          http_json(200, {"choices": [{"message": {"content": '{"segment_prompts":["A","B","C"]}'}}]})],
}
RACE_FIXTURES = (
    ("race/500-json", {"cerebras": "race-500-json-fast", "groq": "race-500-json-slow"}),
    ("race/500-text-and-502", {"cerebras": "race-500-text-fast", "groq": "race-502-text-slow"}),
    ("race/success-after-retry", {"cerebras": "race-ok-after-500", "groq": "race-500-json-slow"}),
    ("race/empty-content", {"cerebras": "dump-empty-content", "groq": "race-empty-content-delayed"}),
)
RACE_ARGS = {"prompts": [], "segment_count": 3, "segment_duration_sec": 5, "rewrite_instruction": "A moonbase thriller"}
SDK_REQUEST = ChatRequest(system_prompt="system instructions", user_content='{"idea": "Café 🌙"}',
                          model="default-model", default_model="default-model", temperature=1.0,
                          max_completion_tokens=1234)


class ScriptedHttpServer(ThreadingHTTPServer):
    """Answer chat-completion POSTs from ``SDK_SCENARIOS`` and record each POST."""

    daemon_threads = True

    def __init__(self, port: int) -> None:
        super().__init__(("127.0.0.1", port), ScriptedHandler)
        self.requests: dict[str, list[dict[str, Any]]] = {}
        self.lock = threading.Lock()


class ScriptedHandler(BaseHTTPRequestHandler):
    """Route ``/<provider>/<scenario>/...`` to its script; answer the Cerebras SDK's warm-up GET with 200."""

    server: ScriptedHttpServer

    def log_message(self, *args: Any) -> None:
        pass

    def do_GET(self) -> None:
        self.send_response(200)
        self.send_header("content-length", "0")
        self.end_headers()

    def do_POST(self) -> None:
        _, provider, scenario, *_ = self.path.split("/")
        length = int(self.headers.get("content-length", "0"))
        raw_body = self.rfile.read(length).decode("utf-8")
        key = f"{provider}/{scenario}"
        with self.server.lock:
            recorded = self.server.requests.setdefault(key, [])
            recorded.append({"path": self.path, "authorization": self.headers.get("authorization"), "raw_body": raw_body})
            script = {**SDK_SCENARIOS, **RACE_SCENARIOS}[scenario] or []
            response = script[min(len(recorded), len(script)) - 1]
        time.sleep(response.get("delay_ms", 0) / 1000)
        payload = response["body"].encode("utf-8")
        self.send_response(response["status"])
        for name, value in response["headers"].items():
            self.send_header(name, value)
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def free_port(exclude: set[int]) -> int:
    """Pick a free port in the range reserved for this generator."""
    for port in range(18400, 18500):
        if port in exclude:
            continue
        with socket.socket() as probe:
            if probe.connect_ex(("127.0.0.1", port)) != 0:
                return port
    raise RuntimeError("No free port in 18400-18499")


def sdk_fixtures() -> list[dict[str, Any]]:
    """Send one request per provider and scenario through the reference VendorClient and the real SDKs."""
    port = free_port(set())
    closed_port = free_port({port})
    server = ScriptedHttpServer(port)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    fixtures = []
    try:
        for provider in ("cerebras", "groq"):
            for scenario, script in SDK_SCENARIOS.items():
                host_port = closed_port if script is None else port
                base_url = f"http://127.0.0.1:{host_port}/{provider}/{scenario}"
                os.environ["CEREBRAS_BASE_URL"] = base_url
                client = build_client(provider=provider, api_key="test-key", api_base_url=base_url)
                vendor = VendorClient(name=provider, request_model="vendor-model", client=client)
                outcome: dict[str, Any]
                stdout = io.StringIO()
                try:
                    with contextlib.redirect_stdout(stdout):
                        reply = asyncio.run(vendor.complete(SDK_REQUEST))
                    outcome = {"text": reply.text, "raw_response_json": json.dumps(reply.raw_response, ensure_ascii=False)}
                except Exception as exc:  # the fixture records the message each SDK failure produces
                    outcome = {"error": str(exc)}
                outcome["diagnostics"] = stdout.getvalue().splitlines()
                fixtures.append({
                    "name": f"sdk/{provider}/{scenario}",
                    "provider": provider,
                    "scenario": scenario,
                    "responses": script,
                    "requests": list(server.requests.get(f"{provider}/{scenario}", [])),
                    **outcome,
                })
                print(f"{provider}/{scenario}: {len(fixtures[-1]['requests'])} requests, {outcome}")
    finally:
        os.environ.pop("CEREBRAS_BASE_URL", None)
        server.shutdown()
    return fixtures


def race_fixtures(templates: PromptTemplates) -> list[dict[str, Any]]:
    """Run rewrite_rollout through the reference enhancer with real SDK clients racing against scripted failures."""
    port = free_port(set())
    server = ScriptedHttpServer(port)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    fixtures = []
    try:
        for name, scenarios in RACE_FIXTURES:
            with server.lock:
                server.requests = {}
            vendors = []
            for provider, scenario in scenarios.items():
                base_url = f"http://127.0.0.1:{port}/{provider}/{scenario}"
                os.environ["CEREBRAS_BASE_URL"] = base_url
                client = build_client(provider=provider, api_key="test-key", api_base_url=base_url)
                request_model = "gpt-oss-120b" if provider == "cerebras" else "openai/gpt-oss-120b"
                vendors.append(VendorClient(name=provider, request_model=request_model, client=client))
            enhancer = PromptEnhancer(PromptSettings(), templates, ProviderRace.from_config(vendors))
            args = dict(RACE_ARGS)
            result = asyncio.run(enhancer.rewrite_rollout(args.pop("prompts"), **args))
            fixtures.append({
                "name": name,
                "args": RACE_ARGS,
                "scenarios": scenarios,
                "requests": {provider: list(server.requests.get(f"{provider}/{scenario}", []))
                             for provider, scenario in scenarios.items()},
                "result": record_result(result),
                "provider_success_counts": enhancer.get_provider_success_counts(),
            })
            print(f"{name}: {fixtures[-1]['result']['error']}")
    finally:
        os.environ.pop("CEREBRAS_BASE_URL", None)
        server.shutdown()
    return fixtures


def main() -> None:
    """Generate every operation and SDK fixture and write ``fixtures.json``."""
    for variable in list(os.environ):
        if variable.startswith("FASTVIDEO_PROMPT_"):
            del os.environ[variable]
    templates = PromptTemplates(devtools_enabled=False)
    system_prompts = {key: getattr(templates, key) for key in TEMPLATE_KEYS}
    clip_cases()
    continuation_cases()
    rollout_cases()
    fixtures = [asyncio.run(run_case(spec, templates, system_prompts)) for spec in CASES]
    names = [fixture["name"] for fixture in fixtures]
    assert len(names) == len(set(names)), "fixture names must be unique"
    sdk = sdk_fixtures()
    race = race_fixtures(templates)
    OUTPUT_PATH.write_text(
        json.dumps({"system_prompts": system_prompts, "fixtures": fixtures, "sdk_request": vars(SDK_REQUEST),
                    "sdk_fixtures": sdk, "sdk_scenarios": {**SDK_SCENARIOS, **RACE_SCENARIOS},
                    "race_fixtures": race}, ensure_ascii=False, indent=1) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {len(fixtures)} operation, {len(sdk)} SDK, and {len(race)} race fixtures to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
