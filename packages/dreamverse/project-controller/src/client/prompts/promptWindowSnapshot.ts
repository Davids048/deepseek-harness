/**
 * Keep nonempty prompt strings in order, trimming surrounding whitespace.
 * @param prompts - a prompt list; any other value counts as an empty list.
 * @returns the trimmed nonempty prompts.
 */
export function normalizePromptWindowSnapshot(
  prompts: unknown,
): string[] {
  if (!Array.isArray(prompts)) {
    return []
  }

  return prompts
    .map((prompt: unknown) => (typeof prompt === 'string' ? prompt.trim() : ''))
    .filter((prompt: string) => prompt.length > 0)
}
