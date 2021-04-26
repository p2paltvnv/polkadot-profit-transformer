import { AccountId, EventRecord, Exposure } from '@polkadot/types/interfaces'
import { TBlockHash, INominator, IValidator, IEraData, IStakingService } from './staking.types'
import { FastifyInstance } from 'fastify'
import { ApiPromise } from '@polkadot/api'
import { Producer } from 'kafkajs'
import fastq from 'fastq'

const {
  environment: { KAFKA_PREFIX }
} = require('../../environment')

interface IBlockEraParams {
  eraId: number
  blockHash: TBlockHash
}
interface IProcessEraPayload {
  eraPayoutEvent: EventRecord
  blockHash: TBlockHash
}

interface IGetValidatorsNominatorsResult {
  nominators: INominator[]
  validators: IValidator[]
}

export default class StakingService implements IStakingService {
  private static instance: StakingService
  private readonly app: FastifyInstance
  private readonly polkadotConnector: ApiPromise
  private readonly kafkaProducer: Producer
  private readonly queue: any

  constructor(app: FastifyInstance) {
    this.app = app
    this.polkadotConnector = app.polkadotConnector
    this.kafkaProducer = app.kafkaProducer
    this.queue = fastq(this, this.processEraPayout, 1)
  }

  static getInstance(app: FastifyInstance): StakingService {
    if (!StakingService.instance) {
      StakingService.instance = new StakingService(app)
    }

    return StakingService.instance
  }

  addToQueue({ eraPayoutEvent, blockHash }: IProcessEraPayload): void {
    this.queue.push({ eraPayoutEvent, blockHash })
  }

  async getEraData({ eraId, blockHash }: IBlockEraParams): Promise<IEraData> {
    const [totalReward, erasRewardPoints, totalStake, sessionStart] = await Promise.all([
      this.polkadotConnector.query.staking.erasValidatorReward.at(blockHash, eraId),
      this.polkadotConnector.query.staking.erasRewardPoints.at(blockHash, eraId),
      this.polkadotConnector.query.staking.erasTotalStake.at(blockHash, eraId),
      this.polkadotConnector.query.staking.erasStartSessionIndex.at(blockHash, eraId)
    ])

    return {
      era: eraId,
      total_reward: totalReward.toString(),
      total_stake: totalStake.toString(),
      total_reward_points: +erasRewardPoints.total.toString(),
      session_start: sessionStart.unwrap().toNumber()
    }
  }

  async getValidatorsAndNominatorsData({ blockHash, eraId }: IBlockEraParams): Promise<IGetValidatorsNominatorsResult> {
    const validatorsAccountIdSet: Set<string> = new Set()
    const eraRewardPointsMap: Map<string, number> = new Map()

    const nominators: INominator[] = []
    const validators: IValidator[] = []

    const eraRewardPointsRaw = await this.polkadotConnector.query.staking.erasRewardPoints.at(blockHash, +eraId)

    eraRewardPointsRaw.individual.forEach((rewardPoints, accountId) => {
      validatorsAccountIdSet.add(accountId.toString())
      eraRewardPointsMap.set(accountId.toString(), rewardPoints.toNumber())
    })

    const processValidator = async (validatorAccountId: string, stakers: Exposure, stakersClipped: Exposure) => {
      const prefs = await this.polkadotConnector.query.staking.erasValidatorPrefs.at(blockHash, eraId, validatorAccountId)

      this.app.log.debug(
        `[validators][getStakersByValidator] Loaded stakers: ${stakers.others.length} for validator "${validatorAccountId}"`
      )

      for (const staker of stakers.others) {
        try {
          const isClipped = stakersClipped.others.find((e: { who: { toString: () => any } }) => {
            return e.who.toString() === staker.who.toString()
          })

          const nominator: INominator = {
            era: eraId,
            account_id: staker.who.toString(),
            validator: validatorAccountId,
            is_clipped: !isClipped,
            value: staker.value.toString()
          }

          const payee = await this.polkadotConnector.query.staking.payee.at(blockHash, staker.who.toString())
          if (payee) {
            if (!payee.isAccount) {
              nominator.reward_dest = payee.toString()
            } else {
              nominator.reward_dest = 'Account'
              nominator.reward_account_id = payee.asAccount
            }
          }

          nominators.push(nominator)
        } catch (e) {
          this.app.log.error(`[validators][getValidators] Cannot process staker: ${staker.who} "${e}". Block: ${blockHash}`)
        }
      }

      let validatorRewardDest: string | undefined = undefined
      let validatorRewardAccountId: AccountId | undefined = undefined
      const validatorPayee = await this.polkadotConnector.query.staking.payee.at(blockHash, validatorAccountId)
      if (validatorPayee) {
        if (!validatorPayee.isAccount) {
          validatorRewardDest = validatorPayee.toString()
        } else {
          validatorRewardDest = 'Account'
          validatorRewardAccountId = validatorPayee.asAccount
        }
      } else {
        this.app.log.warn(`failed to get payee for era: "${eraId}" validator: "${validatorAccountId}". Block: ${blockHash} `)
      }

      const pointsFromMap = eraRewardPointsMap.get(validatorAccountId) ?? 0
      const reward_points = pointsFromMap

      validators.push({
        era: eraId,
        account_id: validatorAccountId,
        total: stakers.total.toString(),
        own: stakers.own.toString(),
        nominators_count: stakers.others.length,
        reward_points,
        reward_dest: validatorRewardDest,
        reward_account_id: validatorRewardAccountId?.toString(),
        prefs: prefs.toJSON()
      })
    }

    for (const validatorAccountId of validatorsAccountIdSet) {
      const [stakers, stakersClipped] = await Promise.all([
        this.polkadotConnector.query.staking.erasStakers.at(blockHash, eraId, validatorAccountId),
        this.polkadotConnector.query.staking.erasStakersClipped.at(blockHash, eraId, validatorAccountId)
      ])

      await processValidator(validatorAccountId, stakers, stakersClipped)
    }

    return {
      validators,
      nominators
    }
  }

  async processEraPayout({ eraPayoutEvent, blockHash }: IProcessEraPayload, cb: (arg0: null) => void): Promise<void> {
    const [eraId] = eraPayoutEvent.event.data

    // TODO: Add node HISTORY_DEPTH checking
    // const currentEra = await this.polkadotConnector.query.staking.currentEra()
    // const historyDepth = await this.polkadotConnector.query.staking.historyDepth.at(blockHash)
    // if (currentEra.unwrap().toNumber() - +eraId > historyDepth.toNumber()) {
    //   this.app.log.warn(`The block height less than HISTORY_DEPTH value: ${historyDepth.toNumber()}`)
    // }

    this.app.log.debug(`Process payout for era: ${eraId}`)

    const blockTime = await this.polkadotConnector.query.timestamp.now.at(blockHash)

    const eraData = await this.getEraData({ blockHash, eraId: +eraId })

    const { validators, nominators } = await this.getValidatorsAndNominatorsData({ blockHash, eraId: +eraId })

    try {
      await this.kafkaProducer.send({
        topic: KAFKA_PREFIX + '_STAKING_ERAS_DATA',
        messages: [
          {
            key: eraData.era.toString(),
            value: JSON.stringify(eraData)
          }
        ]
      })
    } catch (error: any) {
      this.app.log.error(`failed to push era data: `, error)
      throw new Error('cannot push session data to Kafka')
    }

    try {
      await this.kafkaProducer.send({
        topic: KAFKA_PREFIX + '_SESSION_DATA',
        messages: [
          {
            // key: blockData.block.header.number.toString(),
            value: JSON.stringify({
              era: +eraId.toString(),
              validators: validators.map((validator) => ({ ...validator, block_time: blockTime.toNumber() })),
              nominators: nominators.map((nominator) => ({ ...nominator, block_time: blockTime.toNumber() })),
              block_time: blockTime.toNumber()
            })
          }
        ]
      })
    } catch (error: any) {
      this.app.log.error(`failed to push session data: `, error)
      throw new Error('cannot push session data to Kafka')
    }

    console.log('ERA STAKING FINISHED ----------------------')
    cb(null)
  }
}
