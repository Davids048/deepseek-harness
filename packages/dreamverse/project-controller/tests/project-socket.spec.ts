/** The project socket serializes JSON and binary sends and reads browser messages like Starlette's receive_json. */
import { once } from 'node:events'
import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, expect, it } from 'vitest'
import { BrowserProjectSocket, WebSocketDisconnect } from '../src/project-socket.ts'

const PORT = 18321
const servers: WebSocketServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    for (const client of server.clients) client.terminate()
    await new Promise((resolve) => { server.close(resolve) })
  }))
})

/** Connect a browser client to a fresh server and return both ends. */
async function socketPair(): Promise<{ server: WebSocket; browser: WebSocket }> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT })
  servers.push(wss)
  await once(wss, 'listening')
  const browser = new WebSocket(`ws://127.0.0.1:${PORT}`)
  const [server] = await once(wss, 'connection') as [WebSocket]
  await once(browser, 'open')
  return { server, browser }
}

/** Let queued promise continuations run. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve()
}

it('starts each JSON or binary send only after the previous one finished, in call order', async () => {
  const { server } = await socketPair()
  const writes: Array<string | Buffer> = []
  const completions: Array<(error?: Error) => void> = []
  // Hold every write open until the test completes it, to observe the lock.
  server.send = ((data: string | Buffer, _options: object, callback: (error?: Error) => void) => {
    writes.push(data)
    completions.push(callback)
  }) as WebSocket['send']
  const socket = new BrowserProjectSocket(server)

  const first = socket.sendJson({ type: 'media_init', segment_idx: 0 })
  const second = socket.sendBytes(Buffer.from([1, 2]))
  const third = socket.sendJson({ type: 'media_segment_complete', segment_idx: 0 })
  await flush()
  expect(writes).toEqual(['{"type":"media_init","segment_idx":0}'])

  completions[0]!()
  await first
  await flush()
  expect(writes).toEqual(['{"type":"media_init","segment_idx":0}', Buffer.from([1, 2])])

  completions[1]!(new Error('write failed'))
  await expect(second).rejects.toThrow('write failed')
  await flush()
  expect(writes).toHaveLength(3)
  completions[2]!()
  await third
})

it('delivers interleaved sends to the browser in call order with their frame types', async () => {
  const { server, browser } = await socketPair()
  const socket = new BrowserProjectSocket(server)
  const received: Array<string | Buffer> = []
  const allReceived = new Promise<void>((resolve) => {
    browser.on('message', (data: Buffer, isBinary) => {
      received.push(isBinary ? data : data.toString('utf8'))
      if (received.length === 3) resolve()
    })
  })
  await Promise.all([socket.sendJson({ n: 1 }), socket.sendBytes(Buffer.from([7])), socket.sendJson({ n: 2 })])
  await allReceived
  expect(received).toEqual(['{"n":1}', Buffer.from([7]), '{"n":2}'])
})

it('reads messages in order, keeps messages received before a disconnect, then reports the disconnect', async () => {
  const { server, browser } = await socketPair()
  const socket = new BrowserProjectSocket(server)
  const signal = new AbortController().signal
  browser.send(JSON.stringify({ type: 'project_init_v1' }))
  browser.send(Buffer.from([1]))
  browser.close(1001)
  await once(server, 'close')
  expect(await socket.receiveJson(signal)).toEqual({ type: 'project_init_v1' })
  // Starlette's receive_json raises KeyError('text') for a binary frame.
  await expect(socket.receiveJson(signal)).rejects.toThrow(/^'text'$/)
  const disconnect = await socket.receiveJson(signal).catch((error: unknown) => error)
  expect(disconnect).toBeInstanceOf(WebSocketDisconnect)
  expect(disconnect).toMatchObject({ code: 1001 })
  await expect(socket.sendJson({ type: 'late' })).rejects.toBeInstanceOf(WebSocketDisconnect)
})

it('rejects a waiting read with the abort reason', async () => {
  const { server } = await socketPair()
  const socket = new BrowserProjectSocket(server)
  const controller = new AbortController()
  const reading = socket.receiveJson(controller.signal)
  controller.abort(new Error('stop receiving'))
  await expect(reading).rejects.toThrow('stop receiving')
})
