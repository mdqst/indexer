import { ChainId, Token, Fetcher, Route } from '@uniswap/sdk'
import gql from 'graphql-tag'

import {
  Logger,
  NetworkContracts,
  SubgraphDeploymentID,
  timer,
} from '@graphprotocol/common-ts'
import { IndexerManagementClient } from '@graphprotocol/indexer-common'
import { providers } from 'ethers'

export interface CostModelAutomationOptions {
  logger: Logger
  ethereum: providers.JsonRpcProvider
  contracts: NetworkContracts
  indexerManagement: IndexerManagementClient
  injectGrtDaiConversionRate: boolean
}

export const startCostModelAutomation = ({
  logger,
  ethereum,
  contracts,
  indexerManagement,
  injectGrtDaiConversionRate,
}: CostModelAutomationOptions): void => {
  logger = logger.child({ component: 'CostModelAutomation' })

  if (injectGrtDaiConversionRate) {
    monitorAndInjectDaiConversionRate({
      logger,
      ethereum,
      contracts,
      indexerManagement,
    })
  }
}

const monitorAndInjectDaiConversionRate = ({
  logger,
  ethereum,
  contracts,
  indexerManagement,
}: {
  logger: Logger
  ethereum: providers.JsonRpcProvider
  contracts: NetworkContracts
  indexerManagement: IndexerManagementClient
}): void => {
  // FIXME: Make this mainnet-compatible by picking the REAL DAI address?
  const DAI = new Token(
    ChainId.RINKEBY,
    '0xFb49BDaA59d4B7aE6260D22b7D86e6Fe94031b82',
    18,
  )

  const GRT = new Token(ChainId.RINKEBY, contracts.token.address, 18)

  timer(120 * 1000).pipe(async () => {
    const pair = await Fetcher.fetchPairData(GRT, DAI, ethereum)
    const route = new Route([pair], DAI)
    const grtPerDai = route.midPrice.toSignificant(18)

    logger.info(
      'Updating cost models with GRT/DAI conversion rate variable ($DAI)',
      {
        grtPerDai: grtPerDai,
      },
    )

    const result = await indexerManagement
      .query(
        gql`
          {
            costModels {
              deployment
              variables
            }
          }
        `,
      )
      .toPromise()

    if (result.error) {
      logger.warn(`Failed to query cost models`, {
        error: result.error.message || result.error,
      })
      return
    }

    if (!result.data || !result.data.costModels) {
      logger.warn(`No cost models found`)
      return
    }

    for (const costModel of result.data.costModels) {
      const deployment = new SubgraphDeploymentID(costModel.deployment)

      try {
        logger.trace(
          `Update cost model with GRT/DAI conversion rate variable ($DAI)`,
          {
            deployment: deployment.display,
            grtPerDai: `${grtPerDai}`,
          },
        )

        costModel.variables = JSON.stringify({
          ...JSON.parse(costModel.variables),
          DAI: `${grtPerDai}`,
        })

        const result = await indexerManagement
          .mutation(
            gql`
              mutation setCostModel($costModel: CostModelInput!) {
                setCostModel(costModel: $costModel) {
                  deployment
                }
              }
            `,
            {
              costModel,
            },
          )
          .toPromise()

        if (result.error) {
          throw result.error
        }
      } catch (error) {
        logger.warn(
          `Failed to update cost model with GRT/DAI conversion rate variable ($DAI)`,
          {
            deployment: deployment.display,
            error: error.message || error,
          },
        )
      }
    }
  })
}