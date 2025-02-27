import { Inject, Service } from 'typedi'
import { Knex } from 'knex'
import { environment } from '@/environment'
import { QUEUES, TaskMessage } from '@/loaders/rabbitmq'
import { TasksRepository } from '@/libs/tasks.repository'
import { ENTITY, PROCESSING_STATUS } from '@/models/processing_task.model'
import { Logger } from 'pino'
import { BlockModel } from '@/models/block.model'
import { TotalIssuance } from '@/models/total_issuance.model'
import { ApiPromise } from '@polkadot/api'

@Service()
export class BlockMetadataProcessorService {

  constructor(
    @Inject('logger') private readonly logger: Logger,
    @Inject('knex') private readonly knex: Knex,
    private readonly tasksRepository: TasksRepository,
    @Inject('polkadotApi') private readonly polkadotApi: ApiPromise,
  ) {
  }

  public async processTaskMessage<T extends QUEUES.BlocksMetadata>(message: TaskMessage<T>): Promise<void> {
    const { entity_id: blockId, collect_uid } = message

    await this.tasksRepository.increaseAttempts(ENTITY.BLOCK_METADATA, blockId)

    await this.knex.transaction(async (trx) => {
      const taskRecord = await this.tasksRepository.readTaskAndLockRow(ENTITY.BLOCK_METADATA, blockId, trx)

      if (!taskRecord) {
        await trx.rollback()
        this.logger.warn({
          event: 'BlockProcessor.processTaskMessage',
          blockId,
          warning: 'Task record not found. Skip processing',
          collect_uid,
        })
        return
      }

      if (taskRecord.attempts > environment.MAX_ATTEMPTS) {
        await trx.rollback()
        this.logger.warn({
          event: 'BlockProcessor.processTaskMessage',
          blockId,
          warning: `Max attempts on block ${blockId} reached, cancel processing.`,
          collect_uid,
        })
        return
      }

      if (taskRecord.collect_uid !== collect_uid) {
        await trx.rollback()
        this.logger.warn({
          event: 'BlockProcessor.processTaskMessage',
          blockId,
          warning: `Possible block ${blockId} processing task duplication. `
            + `Expected ${collect_uid}, found ${taskRecord.collect_uid}. Skip processing.`,
          collect_uid,
        })
        return
      }

      if (taskRecord.status !== PROCESSING_STATUS.NOT_PROCESSED) {
        await trx.rollback()
        this.logger.warn({
          event: 'BlockProcessor.processTaskMessage',
          blockId,
          warning: `Block  ${blockId} has been already processed. Skip processing.`,
          collect_uid,
        })
        return
      }

      // all is good, start processing
      this.logger.info({
        event: 'BlockProcessor.processTaskMessage',
        blockId,
        message: `Start processing block ${blockId}`,
        collect_uid,
      })

      const newStakingProcessingTasks = await this.processBlock(blockId, trx)

      await this.tasksRepository.setTaskRecordAsProcessed(taskRecord, trx)

      await trx.commit()

      this.logger.info({
        event: 'BlockProcessor.processTaskMessage',
        blockId,
        message: `Block ${blockId} has been processed and committed`,
        collect_uid,
        newStakingProcessingTasks,
      })

    }).catch((error: Error) => {
      this.logger.error({
        event: 'BlockProcessor.processTaskMessage',
        blockId,
        error: error.message,
        data: {
          collect_uid,
        },
      })
      throw error
    })
  }

  private async processBlock(
    blockId: number,
    trx: Knex.Transaction<any, any[]>,
  ): Promise<void> {
    const blockHash = await this.polkadotApi.rpc.chain.getBlockHash(blockId)

    const historicalApi = await this.polkadotApi.at(blockHash)

    const totalIssuance = await historicalApi.query.balances.totalIssuance()

    const network = { network_id: environment.NETWORK_ID }
    await TotalIssuance(this.knex)
      .transacting(trx)
      .insert({
        block_id: blockId,
        total_issuance: totalIssuance.toString(10),
        ...network,
        row_time: new Date()
      })
  }


}
