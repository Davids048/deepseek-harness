"""Generate the TypeScript field layouts of the vendor SDK chat-completion response models.

The reference ``VendorClient`` keeps ``response.model_dump(mode="json")`` of the model that each vendor SDK builds
for ``chat.completions.create``. ``src/llm/sdk-response.ts`` reproduces that dump from the HTTP JSON using the
layouts this script writes to ``src/llm/sdk-response-models.ts``: each model's declared fields in pydantic order,
their types, whether they are required, and the SDK discriminator mappings of model unions.

Run with the reference virtual environment:

    /mnt/lustre/vlm-d1su/codes/fv-hub/.venv-fv/bin/python \\
        /mnt/lustre/vlm-d1su/codes/fv-hub/deepseek-harness/packages/dreamverse/prompt-enhancer/scripts/generate_sdk_response_models.py

The script fails when a model uses a feature the TypeScript emulation does not implement, such as field aliases,
non-None defaults, typed extra fields, or annotation kinds outside the supported set.
"""

from __future__ import annotations

import inspect
import json
import types
import typing
from pathlib import Path
from typing import Any, Literal, Union, get_args, get_origin

import cerebras.cloud.sdk as cerebras_sdk
import openai
import pydantic
from cerebras.cloud.sdk import _models as cerebras_models
from cerebras.cloud.sdk.types.chat.chat_completion import ChatCompletion as CerebrasChatCompletion
from openai import _models as openai_models
from openai.types.chat import ChatCompletion as OpenAIChatCompletion

OUTPUT_PATH = Path(__file__).resolve().parents[1] / "src" / "llm" / "sdk-response-models.ts"
SCALARS = {str: "str", int: "int", float: "float", bool: "bool", type(None): "none"}


def ts_string(value: str) -> str:
    """Render a single-quoted TypeScript string literal, the quote style the repository's lint requires."""
    return "'" + json.dumps(value)[1:-1].replace('\\"', '"').replace("'", "\\'") + "'"


class LayoutWriter:
    """Collect model layouts reachable from one SDK's response type, using that SDK's discriminator rules."""

    def __init__(self, prefix: str, sdk_models: Any) -> None:
        self.prefix = prefix
        self.sdk_models = sdk_models
        self.models: dict[str, list[str]] = {}

    def model_name(self, cls: type) -> str:
        return f"{self.prefix}.{cls.__module__.rsplit('.', 1)[-1]}.{cls.__name__}"

    def encode(self, annotation: Any, metadata: tuple[Any, ...] = ()) -> str:
        """Encode one annotation as a TypeScript `SdkType` literal."""
        if hasattr(annotation, "__value__"):
            annotation = annotation.__value__
        origin = get_origin(annotation)
        args = get_args(annotation)
        if origin is typing.Annotated:
            return self.encode(args[0], metadata or tuple(args[1:]))
        if origin is Union or origin is types.UnionType:
            variants = ", ".join(self.encode(variant) for variant in args)
            details = self.sdk_models._build_discriminated_union_meta(union=annotation, meta_annotations=metadata)
            if details is None:
                return f"{{ kind: 'union', variants: [{variants}] }}"
            assert details.field_alias_from is None, "discriminator aliases are not supported"
            mapping = ", ".join(f"{ts_string(value)}: {ts_string(self.model_name(variant))}"
                                for value, variant in details.mapping.items())
            return (f"{{ kind: 'union', variants: [{variants}], discriminator: "
                    f"{{ field: {ts_string(details.field_name)}, mapping: {{ {mapping} }} }} }}")
        if origin is list:
            return f"{{ kind: 'list', item: {self.encode(args[0])} }}"
        if origin is dict:
            assert args[0] is str, "only string-keyed dictionaries are supported"
            return f"{{ kind: 'dict', value: {self.encode(args[1])} }}"
        if origin is Literal:
            assert all(isinstance(value, str) for value in args), "only string literals are supported"
            values = ", ".join(ts_string(value) for value in args)
            return f"{{ kind: 'literal', values: [{values}] }}"
        if annotation in SCALARS:
            return f"{{ kind: '{SCALARS[annotation]}' }}"
        if inspect.isclass(annotation) and issubclass(annotation, pydantic.BaseModel):
            self.add_model(annotation)
            return f"{{ kind: 'model', name: {ts_string(self.model_name(annotation))} }}"
        raise AssertionError(f"Unsupported annotation {annotation!r}")

    def add_model(self, cls: type[pydantic.BaseModel]) -> None:
        """Record one model's declared fields in pydantic order."""
        name = self.model_name(cls)
        if name in self.models:
            return
        self.models[name] = []
        assert cls.model_config.get("extra") == "allow", f"{name} must allow extra fields"
        assert self.sdk_models._get_extra_fields_type(cls) is None, f"{name} has typed extra fields"
        fields = []
        for field_name, field in cls.model_fields.items():
            assert field.alias is None, f"{name}.{field_name} has an alias"
            required = field.is_required()
            assert required or field.get_default() is None, f"{name}.{field_name} has a non-None default"
            encoded = self.encode(field.annotation, tuple(field.metadata))
            fields.append(f"    [{ts_string(field_name)}, {encoded}, {'true' if required else 'false'}],")
        self.models[name] = fields


def main() -> None:
    """Write the layouts of both SDK response types."""
    openai_writer = LayoutWriter("openai", openai_models)
    openai_root = openai_writer.encode(OpenAIChatCompletion)
    cerebras_writer = LayoutWriter("cerebras", cerebras_models)
    cerebras_root = cerebras_writer.encode(CerebrasChatCompletion)
    models = {**openai_writer.models, **cerebras_writer.models}
    body = "\n".join(f"  {ts_string(name)}: [\n" + "\n".join(fields) + "\n  ]," for name, fields in models.items())
    OUTPUT_PATH.write_text(f"""/**
 * Field layouts of the chat-completion response models that the reference's vendor SDKs build.
 *
 * Why this file exists:
 * the Python DreamVerse reference (`apps/dreamverse/` in the FastVideo checkout) stores each
 * provider reply as the SDK response's `model_dump(mode="json")` (`dreamverse/prompt_enhancement/llm/client.py`).
 * When a rollout reply has no assistant text, `features/rollout.py` rejects it with an error that embeds the first
 * 240 characters of that dump, and the provider race's aggregated error reaches the browser as
 * `rewrite_seed_prompts_complete.error`. `model_dump` lists every declared field in declaration order, writes
 * absent optional fields as `null`, and appends undeclared fields after them. `sdk-response.ts` rebuilds that dump
 * from the raw HTTP JSON with these layouts, so the port's error text matches the reference byte for byte.
 *
 * How it is produced:
 * `scripts/generate_sdk_response_models.py` walks `model_fields` of the OpenAI SDK's
 * `ChatCompletion` (the SDK the reference uses for Groq) and the Cerebras SDK's `ChatCompletion` union, recursing
 * into nested models with each SDK's own discriminator helpers, and records every field as
 * `[name, type, required]`.
 *
 * Generated from openai {openai.__version__}, cerebras-cloud-sdk {cerebras_sdk.__version__}, and pydantic {pydantic.VERSION}.
 * Regenerate it instead of editing it after upgrading either SDK: run
 * `python packages/dreamverse/prompt-enhancer/scripts/generate_sdk_response_models.py` from the repository root in a
 * Python environment that has both SDKs installed.
 *
 * @module @dreamverse/prompt-enhancer/llm/sdk-response-models
 */
import type {{ SdkModel, SdkType }} from './sdk-response.ts'

/** Response models by name; each lists its declared fields in pydantic order as `[name, type, required]`. */
export const SDK_RESPONSE_MODELS: Readonly<Record<string, SdkModel>> = {{
{body}
}}

/** The type the OpenAI SDK builds for `chat.completions.create`, which the reference uses for Groq. */
export const OPENAI_CHAT_COMPLETION: SdkType = {openai_root}

/** The type the Cerebras SDK builds for `chat.completions.create`. */
export const CEREBRAS_CHAT_COMPLETION: SdkType = {cerebras_root}
""", encoding="utf-8")
    print(f"Wrote {len(models)} models to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
