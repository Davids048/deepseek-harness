import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectEventLogger, logFileTimestamp, utcIsoTimestamp } from '../src/index.ts'
import { openProjects } from './harness.ts'

const roots: string[] = []

function logRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dreamverse-log-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('ProjectEventLogger', () => {
  it('creates an empty UTC-stamped JSONL file under the hostname directory', () => {
    const root = logRoot()
    const logger = new ProjectEventLogger(root)
    expect(logger.directory).toBe(join(root, hostname()))
    expect(readdirSync(logger.directory)).toEqual([logger.path.slice(logger.directory.length + 1)])
    expect(logger.path.slice(logger.directory.length + 1)).toMatch(/^\d{6}_\d{6}_\d{6}\.jsonl$/)
    expect(readFileSync(logger.path, 'utf8')).toBe('')
  })

  it('refuses to reuse an existing log file', () => {
    const root = logRoot()
    const startedAt = new Date(Date.UTC(2026, 8, 24, 8, 59, 12, 123))
    void new ProjectEventLogger(root, startedAt)
    expect(() => new ProjectEventLogger(root, startedAt)).toThrow(/EEXIST/)
  })

  it('appends one entry per event with the header keys before the payload keys', () => {
    const logger = new ProjectEventLogger(logRoot())
    logger.writeEvent('append_prompt', 'project-123', { prompt: 'hello world', project_id: 'payload value' })
    logger.writeEvent('ws_stream_complete', 'project-123')
    const lines = readFileSync(logger.path, 'utf8').split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[2]).toBe('')
    const { ts, ...first } = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(Object.keys(JSON.parse(lines[0]!) as object)).toEqual(['ts', 'event', 'hostname', 'project_id', 'prompt'])
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{6})?\+00:00$/)
    expect(first).toEqual({ event: 'append_prompt', hostname: hostname(), project_id: 'payload value', prompt: 'hello world' })
    expect(Object.keys(JSON.parse(lines[1]!) as object)).toEqual(['ts', 'event', 'hostname', 'project_id'])
  })

  it('formats timestamps like Python datetime', () => {
    const withFraction = new Date(Date.UTC(2026, 8, 24, 8, 59, 12, 123))
    const wholeSecond = new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 0))
    expect(logFileTimestamp(withFraction)).toBe('260924_085912_123000')
    expect(logFileTimestamp(wholeSecond)).toBe('260102_030405_000000')
    expect(utcIsoTimestamp(withFraction)).toBe('2026-09-24T08:59:12.123000+00:00')
    expect(utcIsoTimestamp(wholeSecond)).toBe('2026-01-02T03:04:05+00:00')
  })
})

describe('DreamverseProjects.logProjectEvent', () => {
  it('writes connection-level events and only warns when the log write fails', async () => {
    const harness = await openProjects()
    try {
      await harness.service.logProjectEvent('project-1', 'gpu_assigned', { gpu_id: 0 })
      expect(harness.logEvents('gpu_assigned')).toEqual([
        { event: 'gpu_assigned', hostname: hostname(), project_id: 'project-1', gpu_id: 0 },
      ])
      const warn = vi.spyOn(harness.ctx.logger, 'warn').mockImplementation(() => undefined)
      rmSync(join(harness.logRoot, hostname()), { recursive: true })
      await expect(harness.service.logProjectEvent('project-1', 'segment_start')).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledOnce()
      expect(warn.mock.calls[0]![0]).toMatch(/^Failed to write project log \(segment_start\): ENOENT/)
    } finally {
      await harness.dispose()
    }
  })
})
