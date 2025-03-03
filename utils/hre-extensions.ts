import '@nomiclabs/hardhat-ethers'
import 'hardhat-deploy'

import {
  BigNumber,
  BigNumberish,
  Contract,
  providers,
  Signer,
  utils,
} from 'ethers'
import { extendEnvironment, subtask } from 'hardhat/config'
import moment from 'moment'

import { getTokens } from '../config'
import { Address } from '../types/custom/config-types'
import { ERC20 } from '../types/typechain'
import { formatMsg, FormatMsgConfig } from './formatMsg'

declare module 'hardhat/types/runtime' {
  interface HardhatRuntimeEnvironment {
    contracts: ContractsExtension
    tokens: TokensExtension
    evm: EVM
    getNamedSigner: (name: string) => Promise<Signer>
    toBN: (amount: BigNumberish, decimals?: BigNumberish) => BigNumber
    fromBN: (amount: BigNumberish, decimals?: BigNumberish) => BigNumber
    log: (msg: string, config?: LogConfig) => void
  }
}

interface LogConfig extends FormatMsgConfig {
  disable?: boolean
  error?: boolean
}

interface ContractsExtension {
  get: <C extends Contract>(
    name: string,
    config?: ContractsGetConfig
  ) => Promise<C>
}

interface TokensExtension {
  get: (name: string) => Promise<ERC20>
}

interface EVM {
  /**
   * This increases the next block's timestamp by the specified amount of seconds.
   * @param seconds {BigNumberish} Amount of seconds to increase the next block's timestamp by.
   */
  advanceTime: (seconds: BigNumberish | moment.Duration) => Promise<void>

  /**
   * Will mine the specified number of blocks locally. This is helpful when functionality
   * requires a certain number of blocks to be processed for values to change.
   * @param blocks {number} Amount of blocks to mine.
   * @param secsPerBlock {number} Determines how many seconds to increase time by for
   *  each block that is mined. Default is 15.
   */
  advanceBlocks: (blocks?: number, secsPerBlock?: number) => Promise<void>

  /**
   * Creates a snapshot of the blockchain in its current state. It then returns a function
   * that can be used to revert back to the state at which the snapshot was taken.
   */
  snapshot: () => Promise<() => Promise<void>>

  /**
   * This allows for functionality to executed within the scope of the specified number
   * of additional blocks to be mined. Once the supplied function to be called within
   * the scope is executed, the blockchain is reverted back to the state it started at.
   * @param blocks {number} The number of blocks that should be mined.
   * @param fn {function} A function that should be executed once blocks have been mined.
   */
  withBlockScope: <T>(blocks: number, fn: () => T) => Promise<T>

  /**
   * Impersonates a supplied address. This allows for the execution of transactions
   * with the `from` field to be the supplied address. This allows for the context
   * of `msg.sender` in a transaction to also be the supplied address.
   *
   * Once you have completed the action of impersonating an address, you may wish to
   * stop impersonating it. To do this, a `stop` function is also returned for
   * convenience. This may also be achieved by calling `evm.stopImpersonating`.
   *
   * To do this:
   *  1. Impersonate an address.
   *  2. Execute a transaction on a contract by connecting the returned signer.
   *    Ex:
   *      const impersonation = await evm.impersonate(0x123)
   *      await contract.connect(impersonation.signer).functionToCall()
   * @param address {string} An address to start impersonating.
   * @return {Promise<ImpersonateReturn>}
   */
  impersonate: (address: string) => Promise<ImpersonateReturn>

  /**
   * It stops the ability to impersonate an address on the local blockchain.
   * @param address {string} An address to stop impersonating.
   */
  stopImpersonating: (address: string) => Promise<void>
}

interface ImpersonateReturn {
  signer: Signer
  stop: () => Promise<void>
}

interface ContractsGetConfig {
  from?: string | Signer
  at?: string
}

interface AddressData {
  libraries: AddressObj
  proxies: AddressObj & {
    lendingPools: AddressObj
    loanManagers: AddressObj
  }
  logics: AddressObj
}
interface AddressObj {
  [name: string]: Address | AddressObj
}

extendEnvironment((hre) => {
  const { deployments, ethers, network } = hre

  hre.contracts = {
    async get<C extends Contract>(
      name: string,
      config?: ContractsGetConfig
    ): Promise<C> {
      const {
        abi,
        address = config?.at,
      }: { abi: unknown[]; address?: string } = await deployments
        .get(name)
        .catch(() => deployments.getArtifact(name))

      if (address == null)
        throw new Error(
          `No deployment exists for ${name}. If expected, supply an address (config.at)`
        )

      let contract = await ethers.getContractAt(abi, address)

      if (config?.from) {
        const signer = Signer.isSigner(config.from)
          ? config.from
          : ethers.provider.getSigner(config.from)
        contract = contract.connect(signer)
      }

      return contract as C
    },
  }

  hre.tokens = {
    async get(nameOrAddress: string): Promise<ERC20> {
      let address: string
      if (ethers.utils.isAddress(nameOrAddress)) {
        address = nameOrAddress
      } else {
        const tokens = getTokens(network)
        address = tokens.all[nameOrAddress.toUpperCase()]
      }
      return (await ethers.getContractAt('ERC20', address)) as ERC20
    },
  }

  hre.getNamedSigner = async (name: string): Promise<Signer> => {
    const accounts = await hre.getNamedAccounts()
    return ethers.provider.getSigner(accounts[name])
  }

  hre.evm = {
    async advanceTime(seconds: BigNumberish | moment.Duration): Promise<void> {
      if (moment.isDuration(seconds)) seconds = seconds.asSeconds()

      const secsPerBlock = 15
      const blocks = BigNumber.from(seconds).div(secsPerBlock).toNumber()
      await this.advanceBlocks(blocks, secsPerBlock)
    },

    async advanceBlocks(blocks = 1, secsPerBlock = 15): Promise<void> {
      for (let block = 0; block < blocks; block++) {
        await network.provider.send('evm_increaseTime', [secsPerBlock])
        await network.provider.send('evm_mine')
      }
    },

    async snapshot(): Promise<() => Promise<void>> {
      const id = await network.provider.send('evm_snapshot')
      return async () => {
        await network.provider.send('evm_revert', [id])
      }
    },

    async withBlockScope(blocks: number, fn: () => any): Promise<any> {
      const revert = await this.snapshot()
      await this.advanceBlocks(blocks)
      const result = await fn()
      await revert()
      return result
    },

    async impersonate(address: string): Promise<ImpersonateReturn> {
      await network.provider.request({
        method: 'hardhat_impersonateAccount',
        params: [address],
      })
      const signer = await ethers.provider.getSigner(address)
      return {
        signer,
        stop: () => this.stopImpersonating(address),
      }
    },

    async stopImpersonating(address: string): Promise<void> {
      await network.provider.request({
        method: 'hardhat_stopImpersonatingAccount',
        params: [address],
      })
    },
  }

  hre.toBN = (amount: BigNumberish, decimals?: BigNumberish): BigNumber => {
    if (typeof amount === 'string') {
      return ethers.utils.parseUnits(amount, decimals)
    }

    const num = BigNumber.from(amount)
    if (decimals) {
      return num.mul(BigNumber.from('10').pow(decimals))
    }
    return num
  }

  hre.fromBN = (amount: BigNumberish, decimals?: BigNumberish): BigNumber => {
    const num = BigNumber.from(amount)
    if (decimals) {
      return num.div(BigNumber.from('10').pow(decimals))
    }
    return num
  }

  hre.log = (msg: string, config: LogConfig = {}): void => {
    const { disable = process.env.DISABLE_LOGS === 'true' } = config

    if (disable) return
    const fn = config?.error ? process.stderr : process.stdout
    fn.write(formatMsg(msg, config))
  }
})

/**
 * Override `hardhat-deploy` deploy subtask to do some magic after it runs.
 */
subtask('deploy:runDeploy', async (args, hre, runSuper) => {
  if (!runSuper.isDefined) return

  await runSuper(args)

  // Only continue on a live network
  if (!hre.network.live) return

  // Verify contracts on Etherscan
  await hre.run('etherscan-verify', { solcInput: true })

  // Save and verify contracts on Tenderly
  await hre.run('tenderly-contracts')
})
