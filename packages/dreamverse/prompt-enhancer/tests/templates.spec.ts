/** Verify prompt-file loading with isolated files. */
import fs from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PACKAGED_TEMPLATE_DIRECTORY, PromptTemplates, promptFileCandidates } from '../src/templates/loader.ts'
import { PromptRuntimeError } from '../src/utils/errors.ts'
import { normalizePath, withSuffix } from '../src/utils/python-paths.ts'
import { snapshotFiles, temporaryDirectory, templatePathOptions, type TemporaryDirectory } from './support.ts'

// The reference templates live in the FastVideo checkout named by FASTVIDEO_ROOT.
const REFERENCE_RESOURCES = path.join(process.env['FASTVIDEO_ROOT'] ?? '/mnt/lustre/vlm-d1su/codes/fv-hub/fastvideo_ds8_dreamverse_dev',
  'apps/dreamverse/dreamverse/prompt_enhancement/templates/resources')

let temporary: TemporaryDirectory
let tmp: string

beforeEach(() => {
  temporary = temporaryDirectory()
  tmp = temporary.directory
})

afterEach(() => {
  vi.restoreAllMocks()
  temporary.cleanup()
})

/** Read a packaged template. */
function packaged(filename: string): string {
  return fs.readFileSync(path.join(PACKAGED_TEMPLATE_DIRECTORY, filename), 'utf8')
}

/** An error like the one Node raises for a denied file operation. */
function permissionError(filePath: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`EACCES: permission denied, open '${filePath}'`), { code: 'EACCES', syscall: 'open', errno: -13 })
}

describe('packaged templates', () => {
  it('are byte-identical copies of the reference resources when the reference checkout is present', () => {
    const names = fs.readdirSync(PACKAGED_TEMPLATE_DIRECTORY).sort()
    expect(names).toEqual([
      'auto_extension_system_prompt.md', 'next_segment_system_prompt.md', 'ref2va_system_prompt.md',
      'rewrite_user_system_prompt.md', 'rewrite_window_system_prompt.md',
    ])
    if (!fs.existsSync(REFERENCE_RESOURCES)) return
    for (const name of names) {
      expect(fs.readFileSync(path.join(PACKAGED_TEMPLATE_DIRECTORY, name)))
        .toEqual(fs.readFileSync(path.join(REFERENCE_RESOURCES, name)))
    }
  })

  it.each(['rewrite_user_system_prompt.md', 'rewrite_window_system_prompt.md'])('%s paces the requested count', (filename) => {
    const template = packaged(filename)
    for (const marker of ['"desired_segment_count"', '"segment_duration_sec"', 'For one segment', 'For three segments', '"id"', '"label"', '"segment_prompts"']) {
      expect(template).toContain(marker)
    }
    expect(template).not.toMatch(/\b6[ -]segment|\bsix[ -]segment|\b30[ -]second|\b5 seconds|\bsegment [4-6]\b/)
  })

  it('keeps six H3 sections for each requested Ref2VA segment', () => {
    const template = packaged('ref2va_system_prompt.md')
    expect(template).toContain('exactly "desired_segment_count" prompts')
    expect(template).toContain('"segment_duration_sec" seconds')
    expect(template).toContain('all six sections')
    expect([...template.matchAll(/^\d\. `([^`]+)`/gm)].map(match => match[1])).toEqual([
      'subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music',
    ])
    expect(template).toContain('350–500 English words')
    expect(template).toContain('<Picture 1>')
    expect(template).toContain('<Subject 1>')
  })

  it('adds one continuation segment after any history', () => {
    const template = packaged('next_segment_system_prompt.md')
    expect(template).toContain('Each continuation adds one segment lasting "segment_duration_sec" seconds')
    expect(template).toContain('Without user direction, infer the next narrative beat from the supplied history.')
    expect(template).toContain('"next_prompt": "prompt for the next segment"')
    for (const text of ['30 seconds total', '6 sequential segments', 'late segments (5-6)']) expect(template).not.toContain(text)
  })

  it.each(['auto_extension_system_prompt.md', 'next_segment_system_prompt.md', 'ref2va_system_prompt.md'])(
    '%s follows the selected duration', (filename) => {
      const template = packaged(filename)
      expect(template).toContain('"segment_duration_sec" seconds')
      expect(template).not.toMatch(/\b5[ -]seconds?|\bfive[ -]seconds?/)
    })
})

describe('PromptTemplates', () => {
  /** Load the templates that `templatePathOptions` writes into the test directory. */
  function load(): PromptTemplates {
    return new PromptTemplates(templatePathOptions(tmp))
  }

  it('exposes loaded text and the files that supplied it', () => {
    const templates = load()
    expect(templates).toEqual({
      ref2vaSystemPrompt: packaged('ref2va_system_prompt.md').trim(),
      ref2vaSystemPromptSourcePath: path.join(PACKAGED_TEMPLATE_DIRECTORY, 'ref2va_system_prompt.md'),
      enhanceSystemPrompt: 'continuation template',
      enhanceSystemPromptSourcePath: path.join(tmp, 'enhance.md'),
      autoSystemPrompt: 'clip and auto template',
      autoSystemPromptSourcePath: path.join(tmp, 'auto.md'),
      rewriteAllSystemPrompt: 'rewrite template',
      rewriteAllSystemPromptSourcePath: path.join(tmp, 'rewrite_all.md'),
      rewriteUserSystemPrompt: 'initial rollout template',
      rewriteUserSystemPromptSourcePath: path.join(tmp, 'rewrite_user.md'),
    })
  })

  it('loads without writing files or creating directories', () => {
    const options = templatePathOptions(tmp)
    const snapshot = snapshotFiles(tmp)
    const writes = (['writeFileSync', 'mkdirSync', 'cpSync', 'copyFileSync'] as const).map(method => vi.spyOn(fs, method))
    const opens = vi.spyOn(fs, 'openSync')
    new PromptTemplates(options)
    for (const write of writes) expect(write).not.toHaveBeenCalled()
    for (const [, flags] of opens.mock.calls) expect(flags ?? 'r').toBe('r')
    expect(snapshotFiles(tmp)).toEqual(snapshot)
  })

  it.each([['.md', '.txt'], ['.txt', '.md']])('loads the alternate extension of a configured %s path', (configured, available) => {
    fs.writeFileSync(path.join(tmp, `alternate${available}`), 'alternate prompt\n')
    const templates = new PromptTemplates({ ...templatePathOptions(tmp), rewriteAllSystemPromptPath: path.join(tmp, `alternate${configured}`) })
    expect(templates.rewriteAllSystemPrompt).toBe('alternate prompt')
    expect(templates.rewriteAllSystemPromptSourcePath.endsWith(available)).toBe(true)
  })

  it.each(['"""', '\'\'\''])('unwraps a SYSTEM_PROMPT = %s assignment', (quote) => {
    const options = templatePathOptions(tmp)
    fs.writeFileSync(path.join(tmp, 'rewrite_all.md'), `SYSTEM_PROMPT = ${quote}\nfirst line\nsecond line\n${quote}\n`)
    expect(new PromptTemplates(options).rewriteAllSystemPrompt).toBe('first line\nsecond line')
  })

  it('reads UTF-8 text with universal newlines and keeps a byte order mark', () => {
    const options = templatePathOptions(tmp)
    fs.writeFileSync(path.join(tmp, 'rewrite_all.md'), '\ufeffline one\r\nline two\rline three\r\n')
    expect(new PromptTemplates(options).rewriteAllSystemPrompt).toBe('\ufeffline one\nline two\nline three')
  })

  it.each(['enhance.md', 'auto.md', 'rewrite_all.md'])('rejects a missing or empty required %s', (filename) => {
    for (const [failure, message] of [['missing', 'system prompt file not found'], ['empty', 'system prompt file is empty']]) {
      const options = templatePathOptions(tmp)
      const filePath = path.join(tmp, filename)
      if (failure === 'missing') fs.rmSync(filePath)
      else fs.writeFileSync(filePath, ' \n')
      expect(() => new PromptTemplates(options)).toThrow(PromptRuntimeError)
      expect(() => new PromptTemplates(options)).toThrow(message)
    }
  })

  it('names every tried candidate when a required template is missing', () => {
    const options = { ...templatePathOptions(tmp), enhanceSystemPromptPath: path.join(tmp, 'missing.md') }
    expect(() => new PromptTemplates(options)).toThrow(
      `next-segment system prompt file not found. Tried: ${path.join(tmp, 'missing.md')}, ${path.join(tmp, 'missing.txt')}`)
  })

  it.each(['enhance.md', 'rewrite_user.md'])('reports an unreadable %s with its path', (filename) => {
    const options = templatePathOptions(tmp)
    const denied = path.join(tmp, filename)
    const readFileSync = fs.readFileSync
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, readOptions?: unknown) => {
      if (file === denied) throw permissionError(denied)
      return readFileSync(file, readOptions as BufferEncoding)
    }))
    expect(() => new PromptTemplates(options)).toThrow(new RegExp(`Failed to read .* system prompt: .*${filename}`))
  })

  it.each([false, true])('uses the rollout template for an unavailable seed template (missing=%s)', (missing) => {
    const options = templatePathOptions(tmp)
    const seedPath = path.join(tmp, 'rewrite_user.md')
    if (missing) fs.rmSync(seedPath)
    else fs.writeFileSync(seedPath, '\n')
    const templates = new PromptTemplates(options)
    expect(templates.rewriteUserSystemPrompt).toBe('rewrite template')
    expect(templates.rewriteUserSystemPromptSourcePath).toBe(path.join(tmp, 'rewrite_all.md'))
  })

  it.each(['"""', '\'\'\''])('keeps the rewrite fallback for an empty %s-wrapped initial template', (quote) => {
    const options = templatePathOptions(tmp)
    fs.writeFileSync(path.join(tmp, 'rewrite_user.md'), `SYSTEM_PROMPT = ${quote}\n \n${quote}\n`)
    const templates = new PromptTemplates(options)
    expect(templates.rewriteUserSystemPrompt).toBe('rewrite template')
    expect(templates.rewriteUserSystemPromptSourcePath).toBe(path.join(tmp, 'rewrite_all.md'))
  })

  it('selects the packaged file for an absent or blank override', () => {
    const templates = new PromptTemplates({ autoSystemPromptPath: ' \t\n ' })
    for (const [loaded, filename] of [
      [templates.enhanceSystemPromptSourcePath, 'next_segment_system_prompt.md'],
      [templates.autoSystemPromptSourcePath, 'auto_extension_system_prompt.md'],
      [templates.rewriteAllSystemPromptSourcePath, 'rewrite_window_system_prompt.md'],
      [templates.rewriteUserSystemPromptSourcePath, 'rewrite_user_system_prompt.md'],
    ] as const) {
      expect(loaded).toBe(path.join(PACKAGED_TEMPLATE_DIRECTORY, filename))
    }
    expect(templates.autoSystemPrompt).toBe(packaged('auto_extension_system_prompt.md').trim())
  })

  it('loads stripped explicit override paths', () => {
    const custom = path.join(tmp, 'custom')
    fs.mkdirSync(custom)
    const files = {
      enhanceSystemPromptPath: ['next_segment_system_prompt.md', 'enhanceSystemPrompt'],
      autoSystemPromptPath: ['auto_extension_system_prompt.md', 'autoSystemPrompt'],
      rewriteAllSystemPromptPath: ['rewrite_window_system_prompt.md', 'rewriteAllSystemPrompt'],
      rewriteUserSystemPromptPath: ['rewrite_user_system_prompt.md', 'rewriteUserSystemPrompt'],
    } as const
    const overrides: Record<string, string> = {}
    for (const [option, [filename, field]] of Object.entries(files)) {
      fs.writeFileSync(path.join(custom, filename), `custom ${field}\n`)
      overrides[option] = `  ${path.join(custom, filename)} \n`
    }
    const templates = new PromptTemplates(overrides)
    for (const [filename, field] of Object.values(files)) {
      expect(templates[field]).toBe(`custom ${field}`)
      expect(templates[`${field}SourcePath`]).toBe(path.join(custom, filename))
    }
  })
})

describe('Python path semantics', () => {
  it('normalizes paths and replaces suffixes like pathlib', () => {
    expect(normalizePath('a//b/./c/')).toBe('a/b/c')
    expect(normalizePath('/x/../y')).toBe('/x/../y')
    expect(normalizePath('')).toBe('.')
    expect(withSuffix('/a/b.md', '.txt')).toBe('/a/b.txt')
    expect(withSuffix('b', '.md')).toBe('b.md')
    expect(promptFileCandidates('dir//p.txt')).toEqual(['dir/p.txt', 'dir/p.md'])
    expect(promptFileCandidates('p.yaml')).toEqual(['p.yaml'])
  })
})
