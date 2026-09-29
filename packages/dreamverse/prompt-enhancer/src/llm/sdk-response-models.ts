/**
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
 * Generated from openai 3.6.0, cerebras-cloud-sdk 1.91.0, and pydantic 2.11.10.
 * Regenerate it instead of editing it after upgrading either SDK: run
 * `python packages/dreamverse/prompt-enhancer/scripts/generate_sdk_response_models.py` from the repository root in a
 * Python environment that has both SDKs installed.
 *
 * @module @dreamverse/prompt-enhancer/llm/sdk-response-models
 */
import type { SdkModel, SdkType } from './sdk-response.ts'

/** Response models by name; each lists its declared fields in pydantic order as `[name, type, required]`. */
export const SDK_RESPONSE_MODELS: Readonly<Record<string, SdkModel>> = {
  'openai.chat_completion.ChatCompletion': [
    ['id', { kind: 'str' }, true],
    ['choices', { kind: 'list', item: { kind: 'model', name: 'openai.chat_completion.Choice' } }, true],
    ['created', { kind: 'int' }, true],
    ['model', { kind: 'str' }, true],
    ['object', { kind: 'literal', values: ['chat.completion'] }, true],
    ['metadata', { kind: 'union', variants: [{ kind: 'dict', value: { kind: 'str' } }, { kind: 'none' }] }, false],
    ['moderation', { kind: 'union', variants: [{ kind: 'model', name: 'openai.chat_completion.Moderation' }, { kind: 'none' }] }, false],
    ['service_tier', { kind: 'union', variants: [{ kind: 'literal', values: ['auto', 'default', 'flex', 'scale', 'priority', 'fast'] }, { kind: 'none' }] }, false],
    ['system_fingerprint', { kind: 'union', variants: [{ kind: 'str' }, { kind: 'none' }] }, false],
    ['usage', { kind: 'union', variants: [{ kind: 'model', name: 'openai.completion_usage.CompletionUsage' }, { kind: 'none' }] }, false],
  ],
  'openai.chat_completion.Choice': [
    ['finish_reason', { kind: 'literal', values: ['stop', 'length', 'tool_calls', 'content_filter', 'function_call'] }, true],
    ['index', { kind: 'int' }, true],
    ['logprobs', { kind: 'union', variants: [{ kind: 'model', name: 'openai.chat_completion.ChoiceLogprobs' }, { kind: 'none' }] }, false],
    ['message', { kind: 'model', name: 'openai.chat_completion_message.ChatCompletionMessage' }, true],
  ],
  'openai.chat_completion.ChoiceLogprobs': [
    ['content', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'model', name: 'openai.chat_completion_token_logprob.ChatCompletionTokenLogprob' } }, { kind: 'none' }] }, false],
    ['refusal', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'model', name: 'openai.chat_completion_token_logprob.ChatCompletionTokenLogprob' } }, { kind: 'none' }] }, false],
  ],
  'openai.chat_completion_token_logprob.ChatCompletionTokenLogprob': [
    ['token', { kind: 'str' }, true],
    ['bytes', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'int' } }, { kind: 'none' }] }, false],
    ['logprob', { kind: 'float' }, true],
    ['top_logprobs', { kind: 'list', item: { kind: 'model', name: 'openai.chat_completion_token_logprob.TopLogprob' } }, true],
  ],
  'openai.chat_completion_token_logprob.TopLogprob': [
    ['token', { kind: 'str' }, true],
    ['bytes', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'int' } }, { kind: 'none' }] }, false],
    ['logprob', { kind: 'float' }, true],
  ],
  'openai.chat_completion_message.ChatCompletionMessage': [
    ['content', { kind: 'union', variants: [{ kind: 'str' }, { kind: 'none' }] }, false],
    ['refusal', { kind: 'union', variants: [{ kind: 'str' }, { kind: 'none' }] }, false],
    ['role', { kind: 'literal', values: ['assistant'] }, true],
    ['annotations', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'model', name: 'openai.chat_completion_message.Annotation' } }, { kind: 'none' }] }, false],
    ['audio', { kind: 'union', variants: [{ kind: 'model', name: 'openai.chat_completion_audio.ChatCompletionAudio' }, { kind: 'none' }] }, false],
    ['function_call', { kind: 'union', variants: [{ kind: 'model', name: 'openai.chat_completion_message.FunctionCall' }, { kind: 'none' }] }, false],
    ['tool_calls', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'union', variants: [{ kind: 'model', name: 'openai.chat_completion_message_function_tool_call.ChatCompletionMessageFunctionToolCall' }, { kind: 'model', name: 'openai.chat_completion_message_custom_tool_call.ChatCompletionMessageCustomToolCall' }], discriminator: { field: 'type', mapping: { 'function': 'openai.chat_completion_message_function_tool_call.ChatCompletionMessageFunctionToolCall', 'custom': 'openai.chat_completion_message_custom_tool_call.ChatCompletionMessageCustomToolCall' } } } }, { kind: 'none' }] }, false],
  ],
  'openai.chat_completion_message.Annotation': [
    ['type', { kind: 'literal', values: ['url_citation'] }, true],
    ['url_citation', { kind: 'model', name: 'openai.chat_completion_message.AnnotationURLCitation' }, true],
  ],
  'openai.chat_completion_message.AnnotationURLCitation': [
    ['end_index', { kind: 'int' }, true],
    ['start_index', { kind: 'int' }, true],
    ['title', { kind: 'str' }, true],
    ['url', { kind: 'str' }, true],
  ],
  'openai.chat_completion_audio.ChatCompletionAudio': [
    ['id', { kind: 'str' }, true],
    ['data', { kind: 'str' }, true],
    ['expires_at', { kind: 'int' }, true],
    ['transcript', { kind: 'str' }, true],
  ],
  'openai.chat_completion_message.FunctionCall': [
    ['arguments', { kind: 'str' }, true],
    ['name', { kind: 'str' }, true],
  ],
  'openai.chat_completion_message_function_tool_call.ChatCompletionMessageFunctionToolCall': [
    ['id', { kind: 'str' }, true],
    ['function', { kind: 'model', name: 'openai.chat_completion_message_function_tool_call.Function' }, true],
    ['type', { kind: 'literal', values: ['function'] }, true],
  ],
  'openai.chat_completion_message_function_tool_call.Function': [
    ['arguments', { kind: 'str' }, true],
    ['name', { kind: 'str' }, true],
  ],
  'openai.chat_completion_message_custom_tool_call.ChatCompletionMessageCustomToolCall': [
    ['id', { kind: 'str' }, true],
    ['custom', { kind: 'model', name: 'openai.chat_completion_message_custom_tool_call.Custom' }, true],
    ['type', { kind: 'literal', values: ['custom'] }, true],
  ],
  'openai.chat_completion_message_custom_tool_call.Custom': [
    ['input', { kind: 'str' }, true],
    ['name', { kind: 'str' }, true],
  ],
  'openai.chat_completion.Moderation': [
    ['input', { kind: 'union', variants: [{ kind: 'model', name: 'openai.chat_completion.ModerationInputModerationResults' }, { kind: 'model', name: 'openai.chat_completion.ModerationInputError' }], discriminator: { field: 'type', mapping: { 'moderation_results': 'openai.chat_completion.ModerationInputModerationResults', 'error': 'openai.chat_completion.ModerationInputError' } } }, true],
    ['output', { kind: 'union', variants: [{ kind: 'model', name: 'openai.chat_completion.ModerationOutputModerationResults' }, { kind: 'model', name: 'openai.chat_completion.ModerationOutputError' }], discriminator: { field: 'type', mapping: { 'moderation_results': 'openai.chat_completion.ModerationOutputModerationResults', 'error': 'openai.chat_completion.ModerationOutputError' } } }, true],
  ],
  'openai.chat_completion.ModerationInputModerationResults': [
    ['model', { kind: 'str' }, true],
    ['results', { kind: 'list', item: { kind: 'model', name: 'openai.chat_completion.ModerationInputModerationResultsResult' } }, true],
    ['type', { kind: 'literal', values: ['moderation_results'] }, true],
  ],
  'openai.chat_completion.ModerationInputModerationResultsResult': [
    ['categories', { kind: 'dict', value: { kind: 'bool' } }, true],
    ['category_applied_input_types', { kind: 'dict', value: { kind: 'list', item: { kind: 'literal', values: ['text', 'image'] } } }, true],
    ['category_scores', { kind: 'dict', value: { kind: 'float' } }, true],
    ['flagged', { kind: 'bool' }, true],
    ['model', { kind: 'str' }, true],
    ['type', { kind: 'literal', values: ['moderation_result'] }, true],
  ],
  'openai.chat_completion.ModerationInputError': [
    ['code', { kind: 'str' }, true],
    ['message', { kind: 'str' }, true],
    ['type', { kind: 'literal', values: ['error'] }, true],
  ],
  'openai.chat_completion.ModerationOutputModerationResults': [
    ['model', { kind: 'str' }, true],
    ['results', { kind: 'list', item: { kind: 'model', name: 'openai.chat_completion.ModerationOutputModerationResultsResult' } }, true],
    ['type', { kind: 'literal', values: ['moderation_results'] }, true],
  ],
  'openai.chat_completion.ModerationOutputModerationResultsResult': [
    ['categories', { kind: 'dict', value: { kind: 'bool' } }, true],
    ['category_applied_input_types', { kind: 'dict', value: { kind: 'list', item: { kind: 'literal', values: ['text', 'image'] } } }, true],
    ['category_scores', { kind: 'dict', value: { kind: 'float' } }, true],
    ['flagged', { kind: 'bool' }, true],
    ['model', { kind: 'str' }, true],
    ['type', { kind: 'literal', values: ['moderation_result'] }, true],
  ],
  'openai.chat_completion.ModerationOutputError': [
    ['code', { kind: 'str' }, true],
    ['message', { kind: 'str' }, true],
    ['type', { kind: 'literal', values: ['error'] }, true],
  ],
  'openai.completion_usage.CompletionUsage': [
    ['completion_tokens', { kind: 'int' }, true],
    ['prompt_tokens', { kind: 'int' }, true],
    ['total_tokens', { kind: 'int' }, true],
    ['completion_tokens_details', { kind: 'union', variants: [{ kind: 'model', name: 'openai.completion_usage.CompletionTokensDetails' }, { kind: 'none' }] }, false],
    ['compute_units', { kind: 'union', variants: [{ kind: 'int' }, { kind: 'none' }] }, false],
    ['prompt_tokens_details', { kind: 'union', variants: [{ kind: 'model', name: 'openai.completion_usage.PromptTokensDetails' }, { kind: 'none' }] }, false],
  ],
  'openai.completion_usage.CompletionTokensDetails': [
    ['accepted_prediction_tokens', { kind: 'union', variants: [{ kind: 'int' }, { kind: 'none' }] }, false],
    ['audio_tokens', { kind: 'union', variants: [{ kind: 'int' }, { kind: 'none' }] }, false],
    ['reasoning_tokens', { kind: 'union', variants: [{ kind: 'int' }, { kind: 'none' }] }, false],
    ['rejected_prediction_tokens', { kind: 'union', variants: [{ kind: 'int' }, { kind: 'none' }] }, false],
    ['text_tokens', { kind: 'union', variants: [{ kind: 'int' }, { kind: 'none' }] }, false],
  ],
  'openai.completion_usage.PromptTokensDetails': [
    ['audio_tokens', { kind: 'union', variants: [{ kind: 'int' }, { kind: 'none' }] }, false],
    ['cache_write_tokens', { kind: 'union', variants: [{ kind: 'int' }, { kind: 'none' }] }, false],
    ['cached_tokens', { kind: 'union', variants: [{ kind: 'int' }, { kind: 'none' }] }, false],
    ['image_tokens', { kind: 'union', variants: [{ kind: 'int' }, { kind: 'none' }] }, false],
    ['text_tokens', { kind: 'union', variants: [{ kind: 'int' }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatCompletionResponse': [
    ['id', { kind: 'str' }, true],
    ['choices', { kind: 'list', item: { kind: 'model', name: 'cerebras.chat_completion.ChatCompletionResponseChoice' } }, true],
    ['created', { kind: 'int' }, true],
    ['model', { kind: 'str' }, true],
    ['object', { kind: 'literal', values: ['chat.completion'] }, true],
    ['system_fingerprint', { kind: 'str' }, true],
    ['service_tier', { kind: 'union', variants: [{ kind: 'str' }, { kind: 'none' }] }, false],
    ['time_info', { kind: 'union', variants: [{ kind: 'model', name: 'cerebras.chat_completion.ChatCompletionResponseTimeInfo' }, { kind: 'none' }] }, false],
    ['usage', { kind: 'union', variants: [{ kind: 'model', name: 'cerebras.chat_completion.ChatCompletionResponseUsage' }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatCompletionResponseChoice': [
    ['index', { kind: 'int' }, true],
    ['message', { kind: 'model', name: 'cerebras.chat_completion.ChatCompletionResponseChoiceMessage' }, true],
    ['finish_reason', { kind: 'union', variants: [{ kind: 'literal', values: ['stop', 'length', 'content_filter', 'tool_calls'] }, { kind: 'none' }] }, false],
    ['logprobs', { kind: 'union', variants: [{ kind: 'model', name: 'cerebras.chat_completion.ChatCompletionResponseChoiceLogprobs' }, { kind: 'none' }] }, false],
    ['reasoning_logprobs', { kind: 'union', variants: [{ kind: 'model', name: 'cerebras.chat_completion.ChatCompletionResponseChoiceReasoningLogprobs' }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatCompletionResponseChoiceMessage': [
    ['role', { kind: 'literal', values: ['assistant', 'user', 'system', 'tool'] }, true],
    ['content', { kind: 'union', variants: [{ kind: 'str' }, { kind: 'none' }] }, false],
    ['reasoning', { kind: 'union', variants: [{ kind: 'str' }, { kind: 'none' }] }, false],
    ['tool_calls', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'model', name: 'cerebras.chat_completion.ChatCompletionResponseChoiceMessageToolCall' } }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatCompletionResponseChoiceMessageToolCall': [
    ['function', { kind: 'model', name: 'cerebras.chat_completion.ChatCompletionResponseChoiceMessageToolCallFunction' }, true],
    ['type', { kind: 'literal', values: ['function'] }, true],
    ['id', { kind: 'union', variants: [{ kind: 'str' }, { kind: 'none' }] }, false],
    ['index', { kind: 'union', variants: [{ kind: 'int' }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatCompletionResponseChoiceMessageToolCallFunction': [
    ['arguments', { kind: 'union', variants: [{ kind: 'str' }, { kind: 'none' }] }, false],
    ['name', { kind: 'union', variants: [{ kind: 'str' }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatCompletionResponseChoiceLogprobs': [
    ['content', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'model', name: 'cerebras.chat_completion.ChatCompletionResponseChoiceLogprobsContent' } }, { kind: 'none' }] }, false],
    ['refusal', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'model', name: 'cerebras.chat_completion.ChatCompletionResponseChoiceLogprobsRefusal' } }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatCompletionResponseChoiceLogprobsContent': [
    ['token', { kind: 'str' }, true],
    ['logprob', { kind: 'float' }, true],
    ['top_logprobs', { kind: 'list', item: { kind: 'model', name: 'cerebras.chat_completion.ChatCompletionResponseChoiceLogprobsContentTopLogprob' } }, true],
    ['bytes', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'int' } }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatCompletionResponseChoiceLogprobsContentTopLogprob': [
    ['token', { kind: 'str' }, true],
    ['logprob', { kind: 'float' }, true],
    ['bytes', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'int' } }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatCompletionResponseChoiceLogprobsRefusal': [
    ['token', { kind: 'str' }, true],
    ['logprob', { kind: 'float' }, true],
    ['top_logprobs', { kind: 'list', item: { kind: 'model', name: 'cerebras.chat_completion.ChatCompletionResponseChoiceLogprobsRefusalTopLogprob' } }, true],
    ['bytes', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'int' } }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatCompletionResponseChoiceLogprobsRefusalTopLogprob': [
    ['token', { kind: 'str' }, true],
    ['logprob', { kind: 'float' }, true],
    ['bytes', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'int' } }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatCompletionResponseChoiceReasoningLogprobs': [
    ['content', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'model', name: 'cerebras.chat_completion.ChatCompletionResponseChoiceReasoningLogprobsContent' } }, { kind: 'none' }] }, false],
    ['refusal', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'model', name: 'cerebras.chat_completion.ChatCompletionResponseChoiceReasoningLogprobsRefusal' } }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatCompletionResponseChoiceReasoningLogprobsContent': [
    ['token', { kind: 'str' }, true],
    ['logprob', { kind: 'float' }, true],
    ['top_logprobs', { kind: 'list', item: { kind: 'model', name: 'cerebras.chat_completion.ChatCompletionResponseChoiceReasoningLogprobsContentTopLogprob' } }, true],
    ['bytes', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'int' } }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatCompletionResponseChoiceReasoningLogprobsContentTopLogprob': [
    ['token', { kind: 'str' }, true],
    ['logprob', { kind: 'float' }, true],
    ['bytes', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'int' } }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatCompletionResponseChoiceReasoningLogprobsRefusal': [
    ['token', { kind: 'str' }, true],
    ['logprob', { kind: 'float' }, true],
    ['top_logprobs', { kind: 'list', item: { kind: 'model', name: 'cerebras.chat_completion.ChatCompletionResponseChoiceReasoningLogprobsRefusalTopLogprob' } }, true],
    ['bytes', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'int' } }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatCompletionResponseChoiceReasoningLogprobsRefusalTopLogprob': [
    ['token', { kind: 'str' }, true],
    ['logprob', { kind: 'float' }, true],
    ['bytes', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'int' } }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatCompletionResponseTimeInfo': [
    ['completion_time', { kind: 'union', variants: [{ kind: 'float' }, { kind: 'none' }] }, false],
    ['created', { kind: 'union', variants: [{ kind: 'float' }, { kind: 'none' }] }, false],
    ['prompt_time', { kind: 'union', variants: [{ kind: 'float' }, { kind: 'none' }] }, false],
    ['queue_time', { kind: 'union', variants: [{ kind: 'float' }, { kind: 'none' }] }, false],
    ['total_time', { kind: 'union', variants: [{ kind: 'float' }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatCompletionResponseUsage': [
    ['completion_tokens', { kind: 'union', variants: [{ kind: 'int' }, { kind: 'none' }] }, false],
    ['completion_tokens_details', { kind: 'union', variants: [{ kind: 'model', name: 'cerebras.chat_completion.ChatCompletionResponseUsageCompletionTokensDetails' }, { kind: 'none' }] }, false],
    ['image_tokens', { kind: 'union', variants: [{ kind: 'int' }, { kind: 'none' }] }, false],
    ['prompt_tokens', { kind: 'union', variants: [{ kind: 'int' }, { kind: 'none' }] }, false],
    ['prompt_tokens_details', { kind: 'union', variants: [{ kind: 'model', name: 'cerebras.chat_completion.ChatCompletionResponseUsagePromptTokensDetails' }, { kind: 'none' }] }, false],
    ['total_tokens', { kind: 'union', variants: [{ kind: 'int' }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatCompletionResponseUsageCompletionTokensDetails': [
    ['accepted_prediction_tokens', { kind: 'union', variants: [{ kind: 'int' }, { kind: 'none' }] }, false],
    ['reasoning_tokens', { kind: 'union', variants: [{ kind: 'int' }, { kind: 'none' }] }, false],
    ['rejected_prediction_tokens', { kind: 'union', variants: [{ kind: 'int' }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatCompletionResponseUsagePromptTokensDetails': [
    ['cached_tokens', { kind: 'union', variants: [{ kind: 'int' }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatChunkResponse': [
    ['id', { kind: 'str' }, true],
    ['created', { kind: 'int' }, true],
    ['model', { kind: 'str' }, true],
    ['object', { kind: 'literal', values: ['chat.completion.chunk'] }, true],
    ['system_fingerprint', { kind: 'str' }, true],
    ['choices', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'model', name: 'cerebras.chat_completion.ChatChunkResponseChoice' } }, { kind: 'none' }] }, false],
    ['service_tier', { kind: 'union', variants: [{ kind: 'str' }, { kind: 'none' }] }, false],
    ['time_info', { kind: 'union', variants: [{ kind: 'model', name: 'cerebras.chat_completion.ChatChunkResponseTimeInfo' }, { kind: 'none' }] }, false],
    ['usage', { kind: 'union', variants: [{ kind: 'model', name: 'cerebras.chat_completion.ChatChunkResponseUsage' }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatChunkResponseChoice': [
    ['index', { kind: 'int' }, true],
    ['delta', { kind: 'union', variants: [{ kind: 'model', name: 'cerebras.chat_completion.ChatChunkResponseChoiceDelta' }, { kind: 'none' }] }, false],
    ['finish_reason', { kind: 'union', variants: [{ kind: 'literal', values: ['stop', 'length', 'content_filter', 'tool_calls'] }, { kind: 'none' }] }, false],
    ['logprobs', { kind: 'union', variants: [{ kind: 'model', name: 'cerebras.chat_completion.ChatChunkResponseChoiceLogprobs' }, { kind: 'none' }] }, false],
    ['reasoning_logprobs', { kind: 'union', variants: [{ kind: 'model', name: 'cerebras.chat_completion.ChatChunkResponseChoiceReasoningLogprobs' }, { kind: 'none' }] }, false],
    ['text', { kind: 'union', variants: [{ kind: 'str' }, { kind: 'none' }] }, false],
    ['tokens', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'int' } }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatChunkResponseChoiceDelta': [
    ['content', { kind: 'union', variants: [{ kind: 'str' }, { kind: 'none' }] }, false],
    ['reasoning', { kind: 'union', variants: [{ kind: 'str' }, { kind: 'none' }] }, false],
    ['role', { kind: 'union', variants: [{ kind: 'literal', values: ['assistant', 'user', 'system', 'tool'] }, { kind: 'none' }] }, false],
    ['tokens', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'int' } }, { kind: 'none' }] }, false],
    ['tool_calls', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'model', name: 'cerebras.chat_completion.ChatChunkResponseChoiceDeltaToolCall' } }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatChunkResponseChoiceDeltaToolCall': [
    ['function', { kind: 'model', name: 'cerebras.chat_completion.ChatChunkResponseChoiceDeltaToolCallFunction' }, true],
    ['type', { kind: 'literal', values: ['function'] }, true],
    ['id', { kind: 'union', variants: [{ kind: 'str' }, { kind: 'none' }] }, false],
    ['index', { kind: 'union', variants: [{ kind: 'int' }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatChunkResponseChoiceDeltaToolCallFunction': [
    ['arguments', { kind: 'union', variants: [{ kind: 'str' }, { kind: 'none' }] }, false],
    ['name', { kind: 'union', variants: [{ kind: 'str' }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatChunkResponseChoiceLogprobs': [
    ['content', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'model', name: 'cerebras.chat_completion.ChatChunkResponseChoiceLogprobsContent' } }, { kind: 'none' }] }, false],
    ['refusal', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'model', name: 'cerebras.chat_completion.ChatChunkResponseChoiceLogprobsRefusal' } }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatChunkResponseChoiceLogprobsContent': [
    ['token', { kind: 'str' }, true],
    ['logprob', { kind: 'float' }, true],
    ['top_logprobs', { kind: 'list', item: { kind: 'model', name: 'cerebras.chat_completion.ChatChunkResponseChoiceLogprobsContentTopLogprob' } }, true],
    ['bytes', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'int' } }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatChunkResponseChoiceLogprobsContentTopLogprob': [
    ['token', { kind: 'str' }, true],
    ['logprob', { kind: 'float' }, true],
    ['bytes', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'int' } }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatChunkResponseChoiceLogprobsRefusal': [
    ['token', { kind: 'str' }, true],
    ['logprob', { kind: 'float' }, true],
    ['top_logprobs', { kind: 'list', item: { kind: 'model', name: 'cerebras.chat_completion.ChatChunkResponseChoiceLogprobsRefusalTopLogprob' } }, true],
    ['bytes', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'int' } }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatChunkResponseChoiceLogprobsRefusalTopLogprob': [
    ['token', { kind: 'str' }, true],
    ['logprob', { kind: 'float' }, true],
    ['bytes', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'int' } }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatChunkResponseChoiceReasoningLogprobs': [
    ['content', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'model', name: 'cerebras.chat_completion.ChatChunkResponseChoiceReasoningLogprobsContent' } }, { kind: 'none' }] }, false],
    ['refusal', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'model', name: 'cerebras.chat_completion.ChatChunkResponseChoiceReasoningLogprobsRefusal' } }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatChunkResponseChoiceReasoningLogprobsContent': [
    ['token', { kind: 'str' }, true],
    ['logprob', { kind: 'float' }, true],
    ['top_logprobs', { kind: 'list', item: { kind: 'model', name: 'cerebras.chat_completion.ChatChunkResponseChoiceReasoningLogprobsContentTopLogprob' } }, true],
    ['bytes', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'int' } }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatChunkResponseChoiceReasoningLogprobsContentTopLogprob': [
    ['token', { kind: 'str' }, true],
    ['logprob', { kind: 'float' }, true],
    ['bytes', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'int' } }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatChunkResponseChoiceReasoningLogprobsRefusal': [
    ['token', { kind: 'str' }, true],
    ['logprob', { kind: 'float' }, true],
    ['top_logprobs', { kind: 'list', item: { kind: 'model', name: 'cerebras.chat_completion.ChatChunkResponseChoiceReasoningLogprobsRefusalTopLogprob' } }, true],
    ['bytes', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'int' } }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatChunkResponseChoiceReasoningLogprobsRefusalTopLogprob': [
    ['token', { kind: 'str' }, true],
    ['logprob', { kind: 'float' }, true],
    ['bytes', { kind: 'union', variants: [{ kind: 'list', item: { kind: 'int' } }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatChunkResponseTimeInfo': [
    ['completion_time', { kind: 'union', variants: [{ kind: 'float' }, { kind: 'none' }] }, false],
    ['created', { kind: 'union', variants: [{ kind: 'float' }, { kind: 'none' }] }, false],
    ['prompt_time', { kind: 'union', variants: [{ kind: 'float' }, { kind: 'none' }] }, false],
    ['queue_time', { kind: 'union', variants: [{ kind: 'float' }, { kind: 'none' }] }, false],
    ['total_time', { kind: 'union', variants: [{ kind: 'float' }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatChunkResponseUsage': [
    ['completion_tokens', { kind: 'union', variants: [{ kind: 'int' }, { kind: 'none' }] }, false],
    ['completion_tokens_details', { kind: 'union', variants: [{ kind: 'model', name: 'cerebras.chat_completion.ChatChunkResponseUsageCompletionTokensDetails' }, { kind: 'none' }] }, false],
    ['image_tokens', { kind: 'union', variants: [{ kind: 'int' }, { kind: 'none' }] }, false],
    ['prompt_tokens', { kind: 'union', variants: [{ kind: 'int' }, { kind: 'none' }] }, false],
    ['prompt_tokens_details', { kind: 'union', variants: [{ kind: 'model', name: 'cerebras.chat_completion.ChatChunkResponseUsagePromptTokensDetails' }, { kind: 'none' }] }, false],
    ['total_tokens', { kind: 'union', variants: [{ kind: 'int' }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatChunkResponseUsageCompletionTokensDetails': [
    ['accepted_prediction_tokens', { kind: 'union', variants: [{ kind: 'int' }, { kind: 'none' }] }, false],
    ['reasoning_tokens', { kind: 'union', variants: [{ kind: 'int' }, { kind: 'none' }] }, false],
    ['rejected_prediction_tokens', { kind: 'union', variants: [{ kind: 'int' }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ChatChunkResponseUsagePromptTokensDetails': [
    ['cached_tokens', { kind: 'union', variants: [{ kind: 'int' }, { kind: 'none' }] }, false],
  ],
  'cerebras.chat_completion.ErrorChunkResponse': [
    ['error', { kind: 'model', name: 'cerebras.chat_completion.ErrorChunkResponseError' }, true],
    ['status_code', { kind: 'int' }, true],
  ],
  'cerebras.chat_completion.ErrorChunkResponseError': [
    ['id', { kind: 'union', variants: [{ kind: 'str' }, { kind: 'none' }] }, false],
    ['code', { kind: 'union', variants: [{ kind: 'str' }, { kind: 'none' }] }, false],
    ['message', { kind: 'union', variants: [{ kind: 'str' }, { kind: 'none' }] }, false],
    ['param', { kind: 'union', variants: [{ kind: 'str' }, { kind: 'none' }] }, false],
    ['type', { kind: 'union', variants: [{ kind: 'str' }, { kind: 'none' }] }, false],
  ],
}

/** The type the OpenAI SDK builds for `chat.completions.create`, which the reference uses for Groq. */
export const OPENAI_CHAT_COMPLETION: SdkType = { kind: 'model', name: 'openai.chat_completion.ChatCompletion' }

/** The type the Cerebras SDK builds for `chat.completions.create`. */
export const CEREBRAS_CHAT_COMPLETION: SdkType = { kind: 'union', variants: [{ kind: 'model', name: 'cerebras.chat_completion.ChatCompletionResponse' }, { kind: 'model', name: 'cerebras.chat_completion.ChatChunkResponse' }, { kind: 'model', name: 'cerebras.chat_completion.ErrorChunkResponse' }] }
