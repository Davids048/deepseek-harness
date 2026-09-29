/** Assemble archived fragmented MP4 segments into one MP4 Blob for saved clips and downloads. */
import {
  createFile,
  type Box,
  type BoxKind,
  type ISOFile,
  type IsoFileOptions,
  type Movie,
  type Sample,
  type SampleEntryFourCC,
} from 'mp4box'

import type { ArchivedAvSegment } from './avPipeline.ts'

const DEFAULT_REMUX_MIME = 'video/mp4'

/** mp4box `trak` box returned by `ISOFile.getTrackById`. */
type TrackBox = ReturnType<ISOFile['getTrackById']>

/** Remux failure stage: no eligible segments, one segment's MP4 parse, or output assembly. */
export type Fmp4RemuxErrorCode =
  | 'no_segments'
  | 'segment_parse_failed'
  | 'remux_failed'

/** Remux failure whose `code` names the failed stage and whose `cause` keeps the underlying error when one exists. */
export class Fmp4RemuxError extends Error {
  /** Stage that failed. */
  code: Fmp4RemuxErrorCode
  /** Underlying parser or writer error, when one exists. */
  override cause?: unknown

  constructor(
    code: Fmp4RemuxErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message)
    this.name = 'Fmp4RemuxError'
    this.code = code
    this.cause = cause
  }
}

/** Segment selection and output type for `remuxArchivedFmp4Segments`. */
export interface RemuxArchivedFmp4Options {
  /** Include segments that have not received their completion event; defaults to `true`. */
  includeInProgress?: boolean
  /** Output Blob type; defaults to `video/mp4`. */
  mimeType?: string
}

interface ParsedTrack {
  sourceTrackId: number
  type: string
  timescale: number
  width: number
  height: number
  channelCount: number
  sampleRate: number
  sampleSize: number
  language: string
  handler: string
  descriptionBoxes: Box[]
  samples: Sample[]
}

interface ParsedSegment {
  movieTimescale: number
  brands: string[]
  tracks: Map<number, ParsedTrack>
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** Join stored chunks in their received order for the segment parser. */
function concatArrayBuffers(chunks: ArrayBuffer[]): ArrayBuffer {
  const totalSize = chunks.reduce(
    (sum, chunk) => sum + chunk.byteLength,
    0,
  )
  const output = new Uint8Array(totalSize)
  let offset = 0
  for (const chunk of chunks) {
    output.set(new Uint8Array(chunk), offset)
    offset += chunk.byteLength
  }
  return output.buffer
}

function normalizeTrackType(codec: string, fallback = 'avc1'): string {
  const source = typeof codec === 'string' ? codec.trim() : ''
  const firstToken = source.split('.')[0] || ''
  if (firstToken.length === 4) {
    return firstToken
  }
  return fallback
}

function cloneSampleData(data: unknown): Uint8Array<ArrayBuffer> | null {
  if (data instanceof Uint8Array) {
    return new Uint8Array(data).slice()
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data.slice(0))
  }
  return null
}

/** Measure a segment's decoding span in source-track timescale units. */
function computeSegmentTiming(samples: Sample[]): {
  segmentStartDts: number
  segmentDuration: number
} {
  if (!samples.length) {
    return {
      segmentStartDts: 0,
      segmentDuration: 0,
    }
  }

  let minDts = Number.POSITIVE_INFINITY
  let maxEnd = 0
  for (const sample of samples) {
    const dts = toFiniteNumber(sample.dts, 0)
    const duration = Math.max(1, toFiniteNumber(sample.duration, 1))
    minDts = Math.min(minDts, dts)
    maxEnd = Math.max(maxEnd, dts + duration)
  }

  if (!Number.isFinite(minDts)) {
    minDts = 0
  }

  return {
    segmentStartDts: minDts,
    segmentDuration: Math.max(0, maxEnd - minDts),
  }
}

/** Read one segment's track metadata and copy its encoded samples for assembly. */
async function parseArchivedSegment(
  segment: ArchivedAvSegment,
): Promise<ParsedSegment> {
  const segmentBuffer = concatArrayBuffers(segment.chunks)
  if (segmentBuffer.byteLength === 0) {
    throw new Fmp4RemuxError(
      'segment_parse_failed',
      `Segment "${segment.key}" has no bytes.`,
    )
  }

  return new Promise<ParsedSegment>((resolve, reject) => {
    const parser = createFile(true)
    const samplesByTrackId = new Map<number, Sample[]>()
    let readyInfo: Movie | null = null
    let settled = false

    /** Reject this segment once, retaining structured parse errors. */
    const fail = (error: unknown, defaultMessage: string): void => {
      if (settled) {
        return
      }
      settled = true
      if (error instanceof Fmp4RemuxError) {
        reject(error)
        return
      }
      reject(
        new Fmp4RemuxError(
          'segment_parse_failed',
          defaultMessage,
          error,
        ),
      )
    }

    /** Resolve track metadata and collected samples after the parser is flushed. */
    const finish = (): void => {
      if (settled) {
        return
      }

      if (!readyInfo || !Array.isArray(readyInfo.tracks)) {
        fail(
          null,
          `Unable to parse MP4 metadata for segment "${segment.key}".`,
        )
        return
      }

      const tracks = new Map<number, ParsedTrack>()
      for (const trackInfo of readyInfo.tracks) {
        const sourceTrackId = trackInfo.id
        if (!Number.isInteger(sourceTrackId)) {
          continue
        }

        // mp4box declares a trak result, but returns undefined when the current moov lacks the ID.
        const sourceTrack = parser.getTrackById(sourceTrackId) as TrackBox | undefined
        const sampleDescription = sourceTrack?.mdia.minf.stbl.stsd.entries[0]
        const descriptionBoxes = sampleDescription?.boxes ?? []

        tracks.set(sourceTrackId, {
          sourceTrackId,
          type: normalizeTrackType(
            sampleDescription?.type || trackInfo.codec,
            trackInfo.audio ? 'mp4a' : 'avc1',
          ),
          timescale: Math.max(1, toFiniteNumber(trackInfo.timescale, 1)),
          width: Math.max(0, toFiniteNumber(trackInfo.video?.width, 0)),
          height: Math.max(0, toFiniteNumber(trackInfo.video?.height, 0)),
          channelCount: Math.max(
            0,
            toFiniteNumber(trackInfo.audio?.channel_count, 0),
          ),
          sampleRate: Math.max(
            0,
            toFiniteNumber(trackInfo.audio?.sample_rate, 0),
          ),
          sampleSize: Math.max(
            0,
            toFiniteNumber(trackInfo.audio?.sample_size, 0),
          ),
          language:
            typeof trackInfo.language === 'string'
            && trackInfo.language.trim()
              ? trackInfo.language.trim()
              : 'und',
          handler: trackInfo.audio ? 'soun' : 'vide',
          descriptionBoxes,
          samples: samplesByTrackId.get(sourceTrackId) || [],
        })
      }

      settled = true
      resolve({
        movieTimescale: Math.max(1, toFiniteNumber(readyInfo.timescale, 600)),
        brands: Array.isArray(readyInfo.brands)
          ? readyInfo.brands.filter(
            (brand: unknown) =>
              typeof brand === 'string' && brand.trim(),
          )
          : [],
        tracks,
      })
    }

    parser.onError = (module: string, message: string) => {
      fail(
        null,
        `MP4 parse error in segment "${segment.key}" (${module}): ${message}`,
      )
    }

    /** Enable sample extraction for every track declared by the segment. */
    parser.onReady = (info: Movie) => {
      readyInfo = info
      const tracks = Array.isArray(info.tracks) ? info.tracks : []
      for (const track of tracks) {
        if (!Number.isInteger(track.id)) {
          continue
        }
        samplesByTrackId.set(track.id, [])
        parser.setExtractionOptions(track.id, null, {
          nbSamples: Number.MAX_SAFE_INTEGER,
        })
      }
      parser.start()
    }

    /** Keep sample bytes independently of the parser's input buffers. */
    parser.onSamples = (
      trackId: number,
      _user: unknown,
      samples: Sample[],
    ) => {
      const nextSamples = samplesByTrackId.get(trackId) || []
      for (const sample of samples) {
        const copiedData = cloneSampleData(sample.data)
        if (!copiedData || copiedData.byteLength === 0) {
          continue
        }
        nextSamples.push({
          ...sample,
          data: copiedData,
        })
      }
      samplesByTrackId.set(trackId, nextSamples)
    }

    try {
      const mp4Buffer = Object.assign(segmentBuffer.slice(0), { fileStart: 0 })
      parser.appendBuffer(mp4Buffer)
      parser.flush()
      void Promise.resolve().then(finish)
    } catch (error) {
      fail(
        error,
        `Failed to append MP4 segment "${segment.key}" to parser.`,
      )
    }
  })
}

/**
 * Append selected segments in their supplied order on a separate timeline for each output track.
 * @param segments - Archived segments in playback order.
 * @param options - Segment selection and output Blob type.
 * @returns one MP4 Blob containing every sample from the selected segments.
 * @throws Fmp4RemuxError when no segment qualifies, a segment fails to parse, or output assembly fails.
 */
export async function remuxArchivedFmp4Segments(
  segments: ArchivedAvSegment[],
  options: RemuxArchivedFmp4Options = {},
): Promise<Blob> {
  const {
    includeInProgress = true,
    mimeType = DEFAULT_REMUX_MIME,
  } = options
  const selectedSegments = (Array.isArray(segments) ? segments : [])
    .filter(
      segment =>
        Array.isArray(segment.chunks)
        && segment.chunks.length > 0
        && (includeInProgress || segment.completed),
    )

  if (selectedSegments.length === 0) {
    throw new Fmp4RemuxError(
      'no_segments',
      includeInProgress
        ? 'No archived stream data is available for remuxing.'
        : 'No completed segments are available for remuxing.',
    )
  }

  const parsedSegments = await Promise.all(
    selectedSegments.map(segment => parseArchivedSegment(segment)),
  )

  const firstWithTracks = parsedSegments.find(
    segment => segment.tracks.size > 0,
  )
  if (!firstWithTracks) {
    throw new Fmp4RemuxError(
      'remux_failed',
      'No tracks were found while remuxing archived segments.',
    )
  }

  // The first segment with tracks supplies the output format; later samples match tracks by source ID.
  const outputFile = createFile(false)
  outputFile.init({
    brands: firstWithTracks.brands.length > 0
      ? firstWithTracks.brands
      : ['isom'],
    timescale: firstWithTracks.movieTimescale,
  })

  const outputTrackBySourceTrack = new Map<number, number>()
  const trackOffsetBySourceTrack = new Map<number, number>()

  for (const [sourceTrackId, parsedTrack] of firstWithTracks.tracks.entries()) {
    const trackOptions: IsoFileOptions = {
      id: sourceTrackId,
      // addTrack returns undefined for an unregistered sample-entry type; the integer check below reports it.
      type: parsedTrack.type as SampleEntryFourCC,
      timescale: parsedTrack.timescale,
      hdlr: parsedTrack.handler,
      language: parsedTrack.language,
    }
    if (parsedTrack.width > 0) {
      trackOptions.width = parsedTrack.width
    }
    if (parsedTrack.height > 0) {
      trackOptions.height = parsedTrack.height
    }
    if (parsedTrack.channelCount > 0) {
      trackOptions.channel_count = parsedTrack.channelCount
    }
    if (parsedTrack.sampleSize > 0) {
      trackOptions.samplesize = parsedTrack.sampleSize
    }
    if (parsedTrack.sampleRate > 0) {
      trackOptions.samplerate = parsedTrack.sampleRate * 65536
    }
    if (parsedTrack.descriptionBoxes.length > 0) {
      // addTrack passes each box to the sample entry's addBox, which accepts any parsed Box.
      trackOptions.description_boxes = parsedTrack.descriptionBoxes as BoxKind[]
    }

    const outputTrackId = outputFile.addTrack(trackOptions)
    if (!Number.isInteger(outputTrackId)) {
      throw new Fmp4RemuxError(
        'remux_failed',
        `Unable to create output track for source track ${sourceTrackId}.`,
      )
    }
    outputTrackBySourceTrack.set(sourceTrackId, outputTrackId)
    trackOffsetBySourceTrack.set(sourceTrackId, 0)
  }

  let writtenSampleCount = 0

  for (const parsedSegment of parsedSegments) {
    for (const [
      sourceTrackId,
      outputTrackId,
    ] of outputTrackBySourceTrack.entries()) {
      const parsedTrack = parsedSegment.tracks.get(sourceTrackId)
      if (!parsedTrack || parsedTrack.samples.length === 0) {
        continue
      }

      // DTS is decoding time and CTS is composition/presentation time, both in track timescale ticks.
      // Rebase both at this segment's earliest DTS, then append after this track's preceding segments.
      const { segmentStartDts, segmentDuration } = computeSegmentTiming(
        parsedTrack.samples,
      )
      const trackOffset = trackOffsetBySourceTrack.get(sourceTrackId) || 0

      for (const sample of parsedTrack.samples) {
        const sampleData = cloneSampleData(sample.data)
        if (!sampleData || sampleData.byteLength === 0) {
          continue
        }

        const sampleDts = toFiniteNumber(sample.dts, 0)
        const sampleCts = toFiniteNumber(sample.cts, sampleDts)
        const sampleDuration = Math.max(
          1,
          Math.round(toFiniteNumber(sample.duration, 1)),
        )

        outputFile.addSample(outputTrackId, sampleData, {
          sample_description_index: Math.max(
            1,
            Math.round(toFiniteNumber(sample.description_index, 0)) + 1,
          ),
          duration: sampleDuration,
          dts: Math.round(sampleDts - segmentStartDts + trackOffset),
          cts: Math.round(sampleCts - segmentStartDts + trackOffset),
          is_sync: sample.is_sync,
          is_leading: Math.round(toFiniteNumber(sample.is_leading, 0)),
          depends_on: Math.round(toFiniteNumber(sample.depends_on, 0)),
          is_depended_on: Math.round(
            toFiniteNumber(sample.is_depended_on, 0),
          ),
          has_redundancy: Math.round(
            toFiniteNumber(sample.has_redundancy, 0),
          ),
          degradation_priority: Math.round(
            toFiniteNumber(sample.degradation_priority, 0),
          ),
        })
        writtenSampleCount += 1
      }

      trackOffsetBySourceTrack.set(
        sourceTrackId,
        trackOffset + segmentDuration,
      )
    }
  }

  if (writtenSampleCount === 0) {
    throw new Fmp4RemuxError(
      'remux_failed',
      'No media samples were available for remux output.',
    )
  }

  try {
    const outputStream = outputFile.getBuffer()
    const outputBytes = outputStream.buffer.slice(0, outputStream.byteLength)
    return new Blob([outputBytes], { type: mimeType || DEFAULT_REMUX_MIME })
  } catch (error) {
    throw new Fmp4RemuxError(
      'remux_failed',
      'Failed to build remuxed MP4 buffer.',
      error,
    )
  }
}
