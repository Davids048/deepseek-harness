/** Verify prompt-file loading, editor destinations, and backups with isolated files. */
import fs from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getTemplateConfig, saveTemplates, type TemplateUpdate } from '../src/templates/editor.ts'
import { PACKAGED_TEMPLATE_DIRECTORY, PromptTemplates, promptFileCandidates } from '../src/templates/loader.ts'
import { PromptRuntimeError, PromptValueError } from '../src/utils/errors.ts'
import { normalizePath, pathParent, pathSuffixes, withSuffix } from '../src/utils/python-paths.ts'
import { snapshotFiles, temporaryDirectory, templatePathOptions, testTemplates, type TemporaryDirectory } from './support.ts'

// The reference templates live in the FastVideo checkout named by FASTVIDEO_ROOT.
const REFERENCE_RESOURCES = path.join(process.env['FASTVIDEO_ROOT'] ?? '/mnt/lustre/vlm-d1su/codes/fv-hub/fastvideo_ds8_dreamverse_dev',
  'apps/dreamverse/dreamverse/prompt_enhancement/templates/resources')
const TEMPLATE_FIELDS = [
  'next_segment_system_prompt', 'auto_extension_system_prompt', 'rewrite_window_system_prompt', 'rewrite_user_system_prompt',
] as const
const FIELD_FILES = {
  next_segment_system_prompt: 'enhance.md',
  auto_extension_system_prompt: 'auto.md',
  rewrite_window_system_prompt: 'rewrite_all.md',
  rewrite_user_system_prompt: 'rewrite_user.md',
} as const

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
  it('exposes loaded text and editor paths', () => {
    expect(getTemplateConfig(testTemplates(tmp))).toEqual({
      ref2va_system_prompt: 'reference shot template',
      ref2va_system_prompt_path: path.join(tmp, 'ref2va.md'),
      next_segment_system_prompt_path: path.join(tmp, 'enhance.md'),
      auto_extension_system_prompt_path: path.join(tmp, 'auto.md'),
      rewrite_window_system_prompt_path: path.join(tmp, 'rewrite_all.md'),
      rewrite_user_system_prompt_path: path.join(tmp, 'rewrite_user.md'),
      next_segment_system_prompt: 'continuation template',
      auto_extension_system_prompt: 'clip and auto template',
      rewrite_window_system_prompt: 'rewrite template',
      rewrite_user_system_prompt: 'initial rollout template',
    })
  })

  it('loads and reloads without writing files or creating directories', () => {
    const options = templatePathOptions(tmp)
    const snapshot = snapshotFiles(tmp)
    const writes = (['writeFileSync', 'mkdirSync', 'cpSync', 'copyFileSync'] as const).map(method => vi.spyOn(fs, method))
    const opens = vi.spyOn(fs, 'openSync')
    new PromptTemplates(options).reload()
    for (const write of writes) expect(write).not.toHaveBeenCalled()
    for (const [, flags] of opens.mock.calls) expect(flags ?? 'r').toBe('r')
    expect(snapshotFiles(tmp)).toEqual(snapshot)
  })

  it('loads a missing override from its fallback and reports the fallback path', () => {
    const templates = testTemplates(tmp)
    templates.rewriteAllSystemPromptFallbackPath = templates.rewriteAllSystemPromptPath
    templates.rewriteAllSystemPromptPath = path.join(tmp, 'prompts.local', 'rewrite.md')
    templates.reload()
    const config = getTemplateConfig(templates)
    expect(config.rewrite_window_system_prompt).toBe('rewrite template')
    expect(config.rewrite_window_system_prompt_path).toBe(path.join(tmp, 'rewrite_all.md'))
  })

  it.each([['.md', '.txt'], ['.txt', '.md']])('loads the alternate extension of a configured %s path', (configured, available) => {
    const templates = testTemplates(tmp)
    fs.writeFileSync(path.join(tmp, `alternate${available}`), 'alternate prompt\n')
    templates.rewriteAllSystemPromptPath = path.join(tmp, `alternate${configured}`)
    templates.reload()
    expect(templates.rewriteAllSystemPrompt).toBe('alternate prompt')
    expect(templates.rewriteAllSystemPromptSourcePath.endsWith(available)).toBe(true)
  })

  it.each(['"""', '\'\'\''])('unwraps a SYSTEM_PROMPT = %s assignment', (quote) => {
    const templates = testTemplates(tmp)
    fs.writeFileSync(path.join(tmp, 'rewrite_all.md'), `SYSTEM_PROMPT = ${quote}\nfirst line\nsecond line\n${quote}\n`)
    templates.reload()
    expect(templates.rewriteAllSystemPrompt).toBe('first line\nsecond line')
  })

  it('reads UTF-8 text with universal newlines and keeps a byte order mark', () => {
    const templates = testTemplates(tmp)
    fs.writeFileSync(path.join(tmp, 'rewrite_all.md'), '\ufeffline one\r\nline two\rline three\r\n')
    templates.reload()
    expect(templates.rewriteAllSystemPrompt).toBe('\ufeffline one\nline two\nline three')
  })

  it.each(['enhance.md', 'auto.md', 'rewrite_all.md'])('rejects a missing or empty required %s', (filename) => {
    for (const [failure, message] of [['missing', 'system prompt file not found'], ['empty', 'system prompt file is empty']]) {
      const templates = testTemplates(tmp)
      const filePath = path.join(tmp, filename)
      if (failure === 'missing') fs.rmSync(filePath)
      else fs.writeFileSync(filePath, ' \n')
      expect(() => templates.reload()).toThrow(PromptRuntimeError)
      expect(() => templates.reload()).toThrow(message)
      fs.writeFileSync(filePath, 'restored\n')
    }
  })

  it('names every tried candidate when a required template is missing', () => {
    const templates = testTemplates(tmp)
    templates.enhanceSystemPromptPath = path.join(tmp, 'missing.md')
    templates.enhanceSystemPromptFallbackPath = path.join(tmp, 'fallback.txt')
    expect(() => templates.reload()).toThrow(`next-segment system prompt file not found. Tried: ${path.join(tmp, 'missing.md')}, `
      + `${path.join(tmp, 'missing.txt')}, ${path.join(tmp, 'fallback.txt')}, ${path.join(tmp, 'fallback.md')}`)
  })

  it.each(['enhance.md', 'rewrite_user.md'])('reports an unreadable %s with its path', (filename) => {
    const templates = testTemplates(tmp)
    const denied = path.join(tmp, filename)
    const readFileSync = fs.readFileSync
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      if (file === denied) throw permissionError(denied)
      return readFileSync(file, options as BufferEncoding)
    }) as typeof fs.readFileSync)
    expect(() => templates.reload()).toThrow(new RegExp(`Failed to read .* system prompt: .*${filename}`))
  })

  it.each([false, true])('uses the rollout template for an unavailable seed template (missing=%s)', (missing) => {
    const templates = testTemplates(tmp)
    const seedPath = path.join(tmp, 'rewrite_user.md')
    if (missing) fs.rmSync(seedPath)
    else fs.writeFileSync(seedPath, '\n')
    templates.reload()
    expect(templates.rewriteUserSystemPrompt).toBe('rewrite template')
    expect(templates.rewriteUserSystemPromptSourcePath).toBe(path.join(tmp, 'rewrite_all.md'))
    expect(getTemplateConfig(templates).rewrite_user_system_prompt_path).toBe(seedPath)
    saveTemplates(templates, { rewrite_user_system_prompt: 'dedicated initial prompt' })
    expect(fs.readFileSync(seedPath, 'utf8')).toBe('dedicated initial prompt\n')
    expect(fs.readFileSync(path.join(tmp, 'rewrite_all.md'), 'utf8')).toBe('rewrite template\n')
    templates.reload()
    expect(templates.rewriteUserSystemPrompt).toBe('dedicated initial prompt')
  })

  it('selects paths once from developer mode and overrides', () => {
    const overlay = path.join(tmp, 'prompts.local')
    const regular = new PromptTemplates({ devtoolsEnabled: false, devtoolsPromptDirectory: overlay })
    const developer = new PromptTemplates({ devtoolsEnabled: true, devtoolsPromptDirectory: overlay, autoSystemPromptPath: ' \t\n ' })
    for (const [templates, expectedPath, expectedFallback] of [
      [regular, path.join(PACKAGED_TEMPLATE_DIRECTORY, 'auto_extension_system_prompt.md'), null],
      [developer, path.join(overlay, 'auto_extension_system_prompt.md'), path.join(PACKAGED_TEMPLATE_DIRECTORY, 'auto_extension_system_prompt.md')],
    ] as const) {
      expect(templates.autoSystemPromptPath).toBe(expectedPath)
      expect(templates.autoSystemPromptFallbackPath).toBe(expectedFallback)
      expect(templates.autoSystemPromptSourcePath).toBe(path.join(PACKAGED_TEMPLATE_DIRECTORY, 'auto_extension_system_prompt.md'))
    }
    expect(developer.ref2vaSystemPromptPath).toBe(path.join(overlay, 'ref2va_system_prompt.md'))
    expect(developer.ref2vaSystemPromptFallbackPath).toBe(path.join(PACKAGED_TEMPLATE_DIRECTORY, 'ref2va_system_prompt.md'))
    expect(fs.existsSync(overlay)).toBe(false)
  })

  it('prefers a developer overlay file over the packaged template', () => {
    const overlay = path.join(tmp, 'prompts.local')
    fs.mkdirSync(overlay)
    fs.writeFileSync(path.join(overlay, 'ref2va_system_prompt.md'), 'overlay reference\n')
    const templates = new PromptTemplates({ devtoolsEnabled: true, devtoolsPromptDirectory: overlay })
    expect(templates.ref2vaSystemPrompt).toBe('overlay reference')
    expect(templates.ref2vaSystemPromptSourcePath).toBe(path.join(overlay, 'ref2va_system_prompt.md'))
  })

  it.each([false, true])('retains explicit override paths for reload and editing (developer mode=%s)', (devtoolsEnabled) => {
    const custom = path.join(tmp, 'custom')
    fs.mkdirSync(custom)
    const files = {
      enhanceSystemPromptPath: ['next_segment_system_prompt.md', 'next_segment_system_prompt'],
      autoSystemPromptPath: ['auto_extension_system_prompt.md', 'auto_extension_system_prompt'],
      rewriteAllSystemPromptPath: ['rewrite_window_system_prompt.md', 'rewrite_window_system_prompt'],
      rewriteUserSystemPromptPath: ['rewrite_user_system_prompt.md', 'rewrite_user_system_prompt'],
    } as const
    const overrides: Record<string, string> = {}
    for (const [option, [filename, field]] of Object.entries(files)) {
      fs.writeFileSync(path.join(custom, filename), `custom ${field}\n`)
      overrides[option] = `  ${path.join(custom, filename)} \n`
    }
    const templates = new PromptTemplates({ devtoolsEnabled, devtoolsPromptDirectory: path.join(tmp, 'prompts.local'), ...overrides })
    const config = getTemplateConfig(templates)
    for (const [filename, field] of Object.values(files)) {
      expect(config[`${field}_path`]).toBe(path.join(custom, filename))
      expect(config[field]).toBe(`custom ${field}`)
    }
    expect(templates.autoSystemPromptPath).toBe(path.join(custom, 'auto_extension_system_prompt.md'))
    expect(templates.autoSystemPromptFallbackPath).toBeNull()
    const edits: TemplateUpdate = Object.fromEntries(Object.values(files).map(([, field]) => [field, `saved ${field}`]))
    saveTemplates(templates, edits)
    templates.reload()
    const reloaded = getTemplateConfig(templates)
    for (const [filename, field] of Object.values(files)) {
      expect(reloaded[field]).toBe(`saved ${field}`)
      expect(fs.readFileSync(path.join(custom, filename), 'utf8')).toBe(`saved ${field}\n`)
    }
    expect(fs.existsSync(path.join(tmp, 'prompts.local'))).toBe(false)
  })
})

describe('saveTemplates', () => {
  it.each(TEMPLATE_FIELDS)('saves %s to disk and keeps loaded text until reload', (field) => {
    const templates = testTemplates(tmp)
    const loadedText = getTemplateConfig(templates)[field]
    saveTemplates(templates, { [field]: '  saved prompt  ' })
    expect(fs.readFileSync(path.join(tmp, FIELD_FILES[field]), 'utf8')).toBe('saved prompt\n')
    expect(getTemplateConfig(templates)[field]).toBe(loadedText)
    templates.reload()
    expect(getTemplateConfig(templates)[field]).toBe('saved prompt')
  })

  it.each(TEMPLATE_FIELDS)('rejects empty %s without writing', (field) => {
    const templates = testTemplates(tmp)
    const snapshot = snapshotFiles(tmp)
    expect(() => saveTemplates(templates, { [field]: ' \n' })).toThrow(new PromptValueError(`${field} cannot be empty.`))
    expect(snapshotFiles(tmp)).toEqual(snapshot)
  })

  it('keeps one timestamped backup with the source extension', () => {
    const templates = testTemplates(tmp)
    saveTemplates(templates, { rewrite_window_system_prompt: 'saved rewrite' })
    const backups = () => fs.readdirSync(tmp).filter(name => /^rewrite_all\..*\.bak\.md$/.test(name))
    expect(fs.readFileSync(path.join(tmp, 'rewrite_all.md'), 'utf8')).toBe('saved rewrite\n')
    expect(backups()).toHaveLength(1)
    expect(backups()[0]).toMatch(/^rewrite_all\.\d{8}_\d{6}\.bak\.md$/)
    expect(fs.readFileSync(path.join(tmp, backups()[0] ?? ''), 'utf8')).toBe('rewrite template\n')
    const first = backups()
    saveTemplates(templates, { rewrite_window_system_prompt: 'saved rewrite' })
    expect(backups()).toEqual(first)
  })

  it('saves to the loaded fallback when the override file is absent', () => {
    const templates = testTemplates(tmp)
    templates.rewriteAllSystemPromptFallbackPath = templates.rewriteAllSystemPromptPath
    const override = path.join(tmp, 'prompts.local', 'rewrite.md')
    templates.rewriteAllSystemPromptPath = override
    templates.reload()
    saveTemplates(templates, { rewrite_window_system_prompt: 'saved fallback' })
    templates.reload()
    expect(fs.readFileSync(path.join(tmp, 'rewrite_all.md'), 'utf8')).toBe('saved fallback\n')
    expect(getTemplateConfig(templates).rewrite_window_system_prompt_path).toBe(path.join(tmp, 'rewrite_all.md'))
    expect(fs.existsSync(override)).toBe(false)
  })

  it('validates every supplied template before writing any', () => {
    const templates = testTemplates(tmp)
    const before = getTemplateConfig(templates)
    const snapshot = snapshotFiles(tmp)
    expect(() => saveTemplates(templates, {
      next_segment_system_prompt: 'accepted continuation',
      auto_extension_system_prompt: 'accepted automatic continuation',
      rewrite_window_system_prompt: 'accepted rewrite',
      rewrite_user_system_prompt: ' \n',
    })).toThrow('rewrite_user_system_prompt cannot be empty')
    expect(getTemplateConfig(templates)).toEqual(before)
    expect(snapshotFiles(tmp)).toEqual(snapshot)
  })

  it.each(['"""', '\'\'\''])('keeps the rewrite fallback for an empty %s-wrapped initial template', (quote) => {
    const templates = testTemplates(tmp)
    const wrappedText = `SYSTEM_PROMPT = ${quote}\n \n${quote}`
    saveTemplates(templates, { rewrite_user_system_prompt: wrappedText })
    templates.reload()
    expect(fs.readFileSync(path.join(tmp, 'rewrite_user.md'), 'utf8')).toBe(`${wrappedText}\n`)
    expect(getTemplateConfig(templates).rewrite_user_system_prompt).toBe('rewrite template')
    expect(templates.rewriteUserSystemPromptSourcePath).toBe(path.join(tmp, 'rewrite_all.md'))
  })

  it.each(['"""', '\'\'\''])('preserves a %s wrapper in the saved file', (quote) => {
    const templates = testTemplates(tmp)
    const wrappedText = `SYSTEM_PROMPT = ${quote}\n  saved rewrite\n${quote}`
    saveTemplates(templates, { rewrite_window_system_prompt: `  ${wrappedText}  ` })
    expect(fs.readFileSync(path.join(tmp, 'rewrite_all.md'), 'utf8')).toBe(`${wrappedText}\n`)
    expect(getTemplateConfig(templates).rewrite_window_system_prompt).toBe('rewrite template')
    templates.reload()
    expect(getTemplateConfig(templates).rewrite_window_system_prompt).toBe('saved rewrite')
  })

  it.each(TEMPLATE_FIELDS)('rejects a lone surrogate in %s before writing', (field) => {
    for (const surrogate of ['\ud800', '\udfff']) {
      const templates = testTemplates(tmp)
      const before = getTemplateConfig(templates)
      const snapshot = snapshotFiles(tmp)
      const edits: TemplateUpdate = {
        next_segment_system_prompt: 'accepted continuation',
        auto_extension_system_prompt: 'accepted automatic continuation',
        rewrite_window_system_prompt: 'accepted rewrite',
        rewrite_user_system_prompt: 'accepted initial rollout',
        [field]: surrogate,
      }
      expect(() => saveTemplates(templates, edits)).toThrow(new PromptValueError(
        `'utf-8' codec can't encode character '\\u${surrogate.charCodeAt(0).toString(16)}' in position 0: surrogates not allowed`))
      expect(getTemplateConfig(templates)).toEqual(before)
      expect(snapshotFiles(tmp)).toEqual(snapshot)
    }
  })

  it('names a run of lone surrogates by its position range', () => {
    const templates = testTemplates(tmp)
    expect(() => saveTemplates(templates, { rewrite_window_system_prompt: '\udfff\ud800koz\ud800' }))
      .toThrow('can\'t encode characters in position 0-1: surrogates not allowed')
  })

  it('wraps a write failure with the template name and path', () => {
    const templates = testTemplates(tmp)
    const denied = path.join(tmp, 'auto.md')
    const writeFileSync = fs.writeFileSync
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, data: string, options?: fs.WriteFileOptions) => {
      if (file === denied) throw permissionError(denied)
      writeFileSync(file, data, options)
    }) as typeof fs.writeFileSync)
    let failure: unknown
    try {
      saveTemplates(templates, { next_segment_system_prompt: 'saved continuation', auto_extension_system_prompt: 'saved auto' })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(PromptRuntimeError)
    expect((failure as Error).message).toBe(`Failed to save auto-extension system prompt: ${denied}`)
    expect((failure as Error).cause).toMatchObject({ code: 'EACCES' })
    expect(fs.readFileSync(path.join(tmp, 'enhance.md'), 'utf8')).toBe('saved continuation\n')
    expect(fs.readFileSync(denied, 'utf8')).toBe('clip and auto template\n')
  })
})

describe('Python path semantics', () => {
  it('normalizes, splits, and replaces suffixes like pathlib', () => {
    expect(normalizePath('a//b/./c/')).toBe('a/b/c')
    expect(normalizePath('/x/../y')).toBe('/x/../y')
    expect(normalizePath('')).toBe('.')
    expect(pathParent('file.md')).toBe('.')
    expect(pathParent('/file.md')).toBe('/')
    expect(withSuffix('/a/b.md', '.txt')).toBe('/a/b.txt')
    expect(withSuffix('b', '.md')).toBe('b.md')
    expect(pathSuffixes('/a/.hidden.tar.gz')).toEqual(['.tar', '.gz'])
    expect(pathSuffixes('/a/name.')).toEqual([])
    expect(promptFileCandidates('dir//p.txt')).toEqual(['dir/p.txt', 'dir/p.md'])
    expect(promptFileCandidates('p.yaml')).toEqual(['p.yaml'])
  })
})
