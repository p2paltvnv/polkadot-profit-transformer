import { environment } from '@/environment'
import express from 'express'
import prom from 'prom-client'

import { BlocksPreloader } from '../../../modules/streamer/blocks-preloader'

export type PreloaderRestApi = ReturnType<typeof PreloaderRestApi>

export const PreloaderRestApi = (deps: { blocksPreloader: BlocksPreloader }) => {
  const { blocksPreloader } = deps

  const port = environment.REST_API_PORT
  return {
    init: async () => {
      const app = express()

      app.get('/metrics', async function (req, res) {
        res.set('Content-Type', prom.register.contentType)
        res.end(await prom.register.metrics())
      })

      app.get('/health', (req, res) => {
        res.json({ status: 'live' })
      })
      // app.get('/status', (req, res) => {
      //   return res.json({
      //     isPaused: blocksPreloader.isPaused(),
      //     currentBlockId: blocksPreloader.currentBlock(),
      //   })
      // })

      app.get('/pause', (req, res) => {
        blocksPreloader.pause()
        res.send('paused')
      })

      app.get('/resume', (req, res) => {
        blocksPreloader.resume()
        res.send('paused')
      })

      app.get('/processBlock/:blockId', async (req, res) => {
        if (isNaN(Number(req.params.blockId))) return res.json({ error: 'blockId must be a number' })
        await blocksPreloader.preloadOneBlock(Number(req.params.blockId))
        return res.json({ result: 'ok' })
      })

      // app.get('/processEra/:eraId', async (req, res) => {
      //   if (isNaN(Number(req.params.eraId))) return res.json({ error: 'blockId must be a number' })
      //   // await stakingProcessor.process(Number(req.params.eraId))
      //   // rabbitMQ.send(QUEUES.Staking, req.params.eraId)
      //   return res.json({ result: 'ok' })
      // })
      app.listen(port, () => {
        console.log(`server started at http://localhost:${port}`)
      })
    },
  }
}
