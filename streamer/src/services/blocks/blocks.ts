import { SyncStatus } from '../index'
import { Vec } from '@polkadot/types'
import { EventRecord } from '@polkadot/types/interfaces'
import { Codec } from '@polkadot/types/types'
import { IBlockData, IBlocksService, IBlocksStatusResult, IEvent } from './blocks.types'
import { counter } from '../statcollector/statcollector'
import { PolkadotModule } from '../../modules/polkadot.module'
import { KafkaModule } from '../../modules/kafka.module'
import { ILoggerModule, LoggerModule } from '../../modules/logger.module'
import { ExtrinsicsService } from '../extrinsics/extrinsics'
import { IConsumerService } from '../consumer/consumer.types'
import { IExtrinsicsService } from '../extrinsics/extrinsics.types'
import { StakingService } from '../staking/staking'
import { IStakingService } from '../staking/staking.types'
import { BlockRepository } from '../../repositories/block.repository'
import { ConsumerService } from '../consumer/consumer'

class BlocksService implements IBlocksService {
  private readonly blockRepository: BlockRepository
  private readonly kafka: KafkaModule
  private readonly polkadotApi: PolkadotModule
  private readonly logger: ILoggerModule

  private readonly extrinsicsService: IExtrinsicsService
  private readonly stakingService: IStakingService
  private readonly consumerService: IConsumerService

  constructor(
    repository?: BlockRepository,
    polkadotApi?: PolkadotModule,
    logger?: ILoggerModule,
    kafka?: KafkaModule,
    extrinsicsService?: IExtrinsicsService,
    stakingService?: IStakingService,
    consumerService?: IConsumerService
  ) {
    this.blockRepository = repository ?? BlockRepository.inject()
    this.polkadotApi = polkadotApi ?? PolkadotModule.inject()
    this.logger = logger ?? LoggerModule.inject()
    this.kafka = kafka ?? KafkaModule.inject()
    this.extrinsicsService = extrinsicsService ?? new ExtrinsicsService()
    this.stakingService = stakingService ?? StakingService.inject()
    this.consumerService = consumerService ?? new ConsumerService()
  }

  async updateOneBlock(blockNumber: number): Promise<true> {
    await this.processBlock(blockNumber).catch((error) => {
      this.logger.error(`failed to process block #${blockNumber}: ${error}`)
      throw new Error('cannot process block')
    })
    return true
  }

  async processBlock(height: number): Promise<void> {
    let blockHash = null

    if (height == null) {
      throw new Error('empty height and blockHash')
    }

    blockHash = await this.polkadotApi.getBlockHashByHeight(height)

    if (!blockHash) {
      throw new Error('cannot get block hash')
    }

    const [sessionId, blockCurrentEra, activeEra, signedBlock, extHeader, blockTime, events] = await this.polkadotApi.getInfoToProcessBlock(
      blockHash
    )

    const currentEra = parseInt(blockCurrentEra.toString(), 10)
    const era = Number(activeEra.unwrap().get('index'))

    if (!signedBlock) {
      throw new Error('cannot get block')
    }

    const processedEvents = await this.processEvents(signedBlock.block.header.number.toNumber(), events)

    const lastDigestLogEntry = signedBlock.block.header.digest.logs.length - 1

    const blockData: IBlockData = {
      block: {
        header: {
          number: signedBlock.block.header.number.toNumber(),
          hash: signedBlock.block.header.hash.toHex(),
          author: extHeader?.author ? extHeader.author.toString() : '',
          session_id: sessionId.toNumber(),
          currentEra,
          era,
          stateRoot: signedBlock.block.header.stateRoot.toHex(),
          extrinsicsRoot: signedBlock.block.header.extrinsicsRoot.toHex(),
          parentHash: signedBlock.block.header.parentHash.toHex(),
          last_log: lastDigestLogEntry > -1 ? signedBlock.block.header.digest.logs[lastDigestLogEntry].type : '',
          digest: signedBlock.block.header.digest.toString()
        }
      },
      events: processedEvents,
      block_time: blockTime.toNumber()
    }

    this.logger.info(`Process block "${blockData.block.header.number}" with hash ${blockData.block.header.hash}`)

    await this.kafka.sendBlockData(blockData)

    await this.extrinsicsService.extractExtrinsics(
      era,
      sessionId.toNumber(),
      signedBlock.block.header.number,
      events,
      signedBlock.block.extrinsics
    )

    const findEraPayoutEvent = (events: Vec<EventRecord>) => {
      return events.find(
        (event: { event: { section: string; method: string } }) => event.event.section === 'staking' && event.event.method === 'EraPayout'
      )
    }

    const eraPayoutEvent = findEraPayoutEvent(events)

    if (eraPayoutEvent) {
      this.stakingService.addToQueue({ eraPayoutEvent, blockHash })
    }

    counter.inc(1)
  }

  /**
   * Check responses from storage, depended from HISTORY_DEPTH
   *
   * @public
   * @async
   * @param blockNumber
   * @returns {Promise<boolean>}
   */
  async checkHistoryDepthAvailableData(blockNumber: number): Promise<boolean> {
    const blockHash = await this.polkadotApi.getBlockHashByHeight(blockNumber)

    if (!blockHash) {
      this.logger.error(`Cannot get block hash: ${blockNumber}`)
      return false
    }

    const historyDepth = await this.polkadotApi.getHistoryDepth(blockHash)

    const currentRawEra = await this.polkadotApi.getCurrentRawEra()
    const blockRawEra = await this.polkadotApi.getCurrentRawEra(blockHash)

    if (blockRawEra == null) {
      this.logger.error(`Cannot get currentEra by hash: ${blockHash}`)
      return false
    }

    const blockEra = parseInt(blockRawEra.toString(), 10)

    if (currentRawEra.unwrap().toNumber() - blockEra > historyDepth.toNumber()) {
      this.logger.info(`The block height less than HISTORY_DEPTH value: ${historyDepth.toNumber()}`)

      const [sessionId, activeEra, extHeader] = await this.polkadotApi.getInfoToCheckHistoryDepth(blockHash)

      let hasError = false
      if (sessionId == null) {
        hasError = true
        this.logger.error(`Cannot get "sessionId" for block ${blockNumber} by hash: ${blockHash}`)
      }

      if (activeEra == null || activeEra.isNone) {
        hasError = true
        this.logger.error(`Cannot get "activeEra" for block ${blockNumber} by hash: ${blockHash}`)
      }

      if (extHeader == null || extHeader.isEmpty) {
        hasError = true
        this.logger.error(`Cannot get "extHeader" for block ${blockNumber} by hash: ${blockHash}`)
      }

      if (hasError) {
        return false
      }
    }
    return true
  }

  /**
   * Process all blocks with head
   *
   * @public
   * @async
   * @param startBlockNumber
   * @param optionSubscribeFinHead
   * @returns {Promise<void>}
   */
  async processBlocks(startBlockNumber: number | null = null, optionSubscribeFinHead: boolean | null = null): Promise<void> {
    const release = await SyncStatus.acquire()

    if (startBlockNumber === null) {
      startBlockNumber = await this.blockRepository.getLastProcessedBlock()
    }

    this.logger.info(`Starting processBlocks from ${startBlockNumber}`)

    let lastBlockNumber = await this.polkadotApi.getFinBlockNumber()

    this.logger.info(`Processing blocks from ${startBlockNumber} to head: ${lastBlockNumber}`)

    let blockNumber: number = startBlockNumber

    if (!(await this.checkHistoryDepthAvailableData(startBlockNumber))) {
      this.logger.error('Cannot receive storage data older than HISTORY_DEPTH')
      release()
      return
    }

    while (blockNumber <= lastBlockNumber) {
      const chunk = lastBlockNumber - blockNumber >= 10 ? 10 : (lastBlockNumber - blockNumber) % 10
      const processTasks = Array(chunk)
        .fill('')
        .map((_, i) => this.runBlocksWorker(i + 1, blockNumber + i))

      await Promise.all(processTasks)

      blockNumber += 10

      if (blockNumber > lastBlockNumber) {
        lastBlockNumber = await this.polkadotApi.getFinBlockNumber()
      }
    }

    release()

    if (optionSubscribeFinHead) this.consumerService.subscribeFinalizedHeads()
  }

  /**
   * Synchronization status
   *
   * @typedef {Object} SyncSimpleStatus
   * @property {string} status
   * @property {number} fin_height_diff
   * @property {number} height_diff
   */

  /**
   *  Returns synchronization status, and diff between head and finalized head
   *
   * @public
   * @async
   * @returns {Promise<SyncSimpleStatus>}
   */
  async getBlocksStatus(): Promise<IBlocksStatusResult> {
    const result = {
      status: 'undefined',
      height_diff: -1,
      fin_height_diff: -1
    }

    if (SyncStatus.isLocked()) {
      result.status = 'synchronization'
    } else {
      result.status = 'synchronized'
    }

    try {
      const lastBlockNumber = await this.polkadotApi.getFinBlockNumber()
      const lastHeader = await this.polkadotApi.getHeader()
      const lastLocalNumber = await this.blockRepository.getLastProcessedBlock()

      result.height_diff = lastBlockNumber - lastLocalNumber
      result.fin_height_diff = lastHeader.number.toNumber() - lastBlockNumber
    } catch (err) {
      this.logger.error(`failed to get block diff: ${err}`)
    }

    return result
  }

  /**
   * Remove blocks data from database by numbers
   *
   * @public
   * @async
   * @param {number[]} blockNumbers
   * @returns {Promise<{result: boolean}>}
   */
  async removeBlocks(blockNumbers: number[]): Promise<{ result: true }> {
    await this.blockRepository.removeBlockData(blockNumbers)

    return { result: true }
  }

  /**
   * Trim last blocks and update up to finalized head
   *
   * @param {number} startBlockNumber
   * @returns {Promise<{result: boolean}>}
   */
  async trimAndUpdateToFinalized(startBlockNumber: number): Promise<{ result: boolean }> {
    if (SyncStatus.isLocked()) {
      this.logger.error(`failed setup "trimAndUpdateToFinalized": sync in process`)
      return { result: false }
    }

    try {
      await this.blockRepository.trimBlocksFrom(startBlockNumber)
      await this.processBlocks(startBlockNumber)
    } catch (err) {
      this.logger.error(`failed to execute trimAndUpdateToFinalized: ${err}`)
    }
    return { result: true }
  }

  /**
   *
   * @param {number} ms
   * @returns {Promise<>}
   */
  async sleep(ms: number): Promise<any> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms)
    })
  }

  /**
   *
   * @private
   * @async
   * @param workerId
   * @param blockNumber
   * @returns {Promise<boolean>}
   */
  private async runBlocksWorker(workerId: number, blockNumber: number) {
    for (let attempts = 5; attempts > 0; attempts--) {
      let lastError = null
      await this.processBlock(blockNumber).catch((error) => {
        lastError = error
        this.logger.error(`Worker id: "${workerId}" Failed to process block #${blockNumber}: ${error}`)
      })

      if (!lastError) {
        return true
      }

      await this.sleep(2000)
    }
    return false
  }

  private async processEvents(blockNumber: number, events: Vec<EventRecord>) {
    const processEvent = (acc: Array<IEvent>, record: EventRecord, eventIndex: number): Array<IEvent> => {
      const { event, phase } = record

      const types = event.typeDef

      const extractEventData = (eventDataRaw: any[]): { [x: string]: Codec }[] =>
        eventDataRaw.map((data: any, index: number) => ({ [types[index].type]: data }))

      acc.push({
        id: `${blockNumber}-${eventIndex}`,
        section: event.section,
        method: event.method,
        phase: phase.toJSON(),
        meta: event.meta.toJSON(),
        data: extractEventData(event.data),
        event: event.toJSON()
      })

      return acc
    }

    return events.reduce(processEvent, [])
  }
}

/**
 *
 * @type {{BlocksService: BlocksService}}
 */
export { BlocksService }
