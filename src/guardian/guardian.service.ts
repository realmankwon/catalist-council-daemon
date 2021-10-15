import {
  Inject,
  Injectable,
  LoggerService,
  OnModuleInit,
} from '@nestjs/common';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { DepositService } from 'deposit';
import { RegistryService } from 'registry';
import { ProviderService } from 'provider';
import { SecurityService } from 'security';
import { TransportInterface } from 'transport';
import { ContractsState } from './interfaces';
import {
  getMessageTopicPrefix,
  GUARDIAN_DEPOSIT_RESIGNING_BLOCKS,
} from './guardian.constants';
import { Configuration } from 'common/config';

@Injectable()
export class GuardianService implements OnModuleInit {
  constructor(
    @Inject(WINSTON_MODULE_NEST_PROVIDER) private logger: LoggerService,
    private registryService: RegistryService,
    private depositService: DepositService,
    private securityService: SecurityService,
    private providerService: ProviderService,
    private transportService: TransportInterface,
    private config: Configuration,
  ) {}

  public async onModuleInit(): Promise<void> {
    await this.depositService.initialize();
    this.subscribeToEthereumUpdates();
  }

  public subscribeToEthereumUpdates() {
    const provider = this.providerService.provider;

    provider.on('block', () => this.checkKeysIntersections());
    this.logger.log('GuardianService subscribed to Ethereum events');
  }

  public getKeysIntersections(
    nextSigningKeys: string[],
    depositedPubKeys: Set<string>,
  ): string[] {
    return nextSigningKeys.filter((nextSigningKey) =>
      depositedPubKeys.has(nextSigningKey),
    );
  }

  private isCheckingKeysIntersections = false;

  public async checkKeysIntersections(): Promise<void> {
    if (this.isCheckingKeysIntersections) return;

    try {
      this.isCheckingKeysIntersections = true;

      const [nextSigningKeys, depositedPubKeys] = await Promise.all([
        this.registryService.getNextSigningKeys(),
        this.depositService.getAllDepositedPubKeys(),
      ]);

      const intersections = this.getKeysIntersections(
        nextSigningKeys,
        depositedPubKeys,
      );

      const isIntersectionsFound = intersections.length > 0;

      if (isIntersectionsFound) {
        this.logger.warn('Already deposited keys found', {
          keys: intersections,
        });

        await this.handleKeysIntersections();
      } else {
        await this.handleCorrectKeys();
      }
    } catch (error) {
      this.logger.error(error);
    } finally {
      this.isCheckingKeysIntersections = false;
    }
  }

  public async handleKeysIntersections(): Promise<void> {
    const [pauseMessageData, isDepositsPaused] = await Promise.all([
      this.securityService.getPauseDepositData(),
      this.securityService.isDepositsPaused(),
    ]);

    if (isDepositsPaused) {
      this.logger.warn('Deposits are already paused');
      return;
    }

    const { blockNumber, signature } = pauseMessageData;

    // call without waiting for completion
    this.securityService.pauseDeposits(blockNumber, signature);

    this.logger.warn('Suspicious case detected', pauseMessageData);
    await this.sendMessage(pauseMessageData);
  }

  private lastContractsState: ContractsState | null = null;

  public async handleCorrectKeys(): Promise<void> {
    const [keysOpIndex, depositRoot, blockNumber] = await Promise.all([
      this.registryService.getKeysOpIndex(),
      this.depositService.getDepositRoot(),
      this.providerService.getBlockNumber(),
    ]);

    const currentContractState = { keysOpIndex, depositRoot, blockNumber };
    const lastContractsState = this.lastContractsState;

    this.lastContractsState = currentContractState;

    const isSameContractsState = this.isSameContractsStates(
      currentContractState,
      lastContractsState,
    );

    if (isSameContractsState) return;

    const depositData = await this.securityService.getDepositData(
      depositRoot,
      keysOpIndex,
    );

    this.logger.log('No problems found', depositData);
    await this.sendMessage(depositData);
  }

  public isSameContractsStates(
    firstState: ContractsState | null,
    secondState: ContractsState | null,
  ): boolean {
    if (!firstState || !secondState) return false;
    if (firstState.depositRoot !== secondState.depositRoot) return false;
    if (firstState.keysOpIndex !== secondState.keysOpIndex) return false;
    if (
      Math.floor(firstState.blockNumber / GUARDIAN_DEPOSIT_RESIGNING_BLOCKS) !==
      Math.floor(secondState.blockNumber / GUARDIAN_DEPOSIT_RESIGNING_BLOCKS)
    ) {
      return false;
    }

    return true;
  }

  public async getMessageTopic(): Promise<string> {
    const chainId = await this.providerService.getChainId();
    const prefix = getMessageTopicPrefix(chainId);
    const topic = this.config.KAFKA_TOPIC;

    return `${prefix}-${topic}`;
  }

  public async sendMessage(message: unknown): Promise<void> {
    const topic = await this.getMessageTopic();
    await this.transportService.publish(topic, message);
  }
}
