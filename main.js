import fs from 'fs/promises';
import { ethers } from 'ethers';
import logger from './logger.js';
import { SETTINGS, FLOW, randomDelay, getRandomInRange } from './config.js';

// Import chain modules from chains folder
import processArbitrumSepoliaSwap from './chains/euclid-arbitrum-sepolia.js';
import processBaseSepoliaSwap from './chains/euclid-base-sepolia.js';
import processEthereumSepoliaSwap from './chains/euclid-ethereum-sepolia.js';
import processLineaSwap from './chains/euclid-linea.js';
import processMegaethSwap from './chains/euclid-megaeth.js';
import processMonadSwap from './chains/euclid-monad.js';
import processOptimismSwap from './chains/euclid-optimism.js';
import processOsmosisSwap from './chains/euclid-osmosis.js';
import processOraichainSwap from './chains/euclid-oraichain.js';
import processSomniaSwap from './chains/euclid-somnia.js';
import processSoneiumSwap from './chains/euclid-soneium.js';

const rl = (await import('readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
const question = async (query) => await rl.question(query);

const readPrivateKeys = async () => {
  try {
    const data = await fs.readFile('data/private_keys.txt', 'utf8');
    return data
      .split('\n')
      .map(key => key.replace(/\r/g, '').trim())
      .filter(key => key && key.startsWith('0x'));
  } catch (error) {
    logger.error(`Failed to read data/private_keys.txt: ${error.message}`);
    return [];
  }
};

const readCosmosKeys = async () => {
  try {
    const data = await fs.readFile('data/cosmos_keys.txt', 'utf8');
    return data
      .split('\n')
      .map(key => key.replace(/\r/g, '').trim())
      .filter(key => key && key.startsWith('0x'));
  } catch (error) {
    logger.error(`Failed to read data/cosmos_keys.txt: ${error.message}`);
    return [];
  }
};

// Function to process wallets in parallel with concurrency limit
const processInParallel = async (items, concurrency, processFn) => {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (item, index) => {
        try {
          return await processFn(item, i + index + 1);
        } catch (error) {
          logger.error(`Error processing item ${i + index + 1}: ${error.message}`);
          return null;
        }
      })
    );
    results.push(...batchResults);
  }
  return results;
};

const chainOptions = [
  { id: '1', name: 'Arbitrum Sepolia', process: processArbitrumSepoliaSwap, flow: FLOW.arbitrum },
  { id: '2', name: 'Base Sepolia', process: processBaseSepoliaSwap, flow: FLOW.base },
  { id: '3', name: 'Ethereum Sepolia', process: processEthereumSepoliaSwap, flow: FLOW.ethereum_sepolia },
  { id: '4', name: 'Monad', process: processMonadSwap, flow: FLOW.monad },
  { id: '5', name: 'MegaETH', process: processMegaethSwap, flow: FLOW.megaeth },
  { id: '6', name: 'Somnia', process: processSomniaSwap, flow: FLOW.somnia },
  { id: '7', name: 'Optimism Sepolia', process: processOptimismSwap, flow: FLOW.optimism },
  { id: '8', name: 'Linea Sepolia', process: processLineaSwap, flow: FLOW.linea },
  { id: '9', name: 'Soneium Minato Testnet', process: processSoneiumSwap, flow: FLOW.soneium },
  { id: '10', name: 'Osmosis Testnet', process: processOsmosisSwap, flow: FLOW.osmosis },
  { id: '11', name: 'Oraichain Testnet', process: processOraichainSwap, flow: FLOW.oraichain },
];

async function main() {
  logger.banner();
  const privateKeys = await readPrivateKeys();
  const cosmosKeys = await readCosmosKeys();
  
  if (privateKeys.length === 0 && cosmosKeys.length === 0) {
    logger.error(`No private keys found in either private_keys.txt or cosmos_keys.txt.`);
    rl.close();
    return;
  }
  logger.info(`Found ${privateKeys.length} EVM private keys and ${cosmosKeys.length} Cosmos keys`);

  while (true) {
    console.log('\nSelect which chain to run:');
    chainOptions.forEach(opt => console.log(`${opt.id}. ${opt.name}`));
    console.log('0. Exit');
    const choice = await question('Enter option number: ');
    if (choice === '0') {
      logger.info('Exiting...');
      rl.close();
      return;
    }
    const selected = chainOptions.find(opt => opt.id === choice);
    if (!selected) {
      logger.error('Invalid option. Try again.');
      continue;
    }

    // Enhanced automation interface
    logger.info(`🎯 Selected: ${selected.name}`);
    console.log('');

    // Choose which keys to use based on chain
    const isCosmosChain = selected.name === 'Osmosis Testnet' || selected.name === 'Oraichain Testnet';
    const keysToUse = isCosmosChain ? cosmosKeys : privateKeys;
    const keyType = isCosmosChain ? 'Cosmos' : 'EVM';
    
    if (keysToUse.length === 0) {
      if (isCosmosChain) {
        logger.error(`No Cosmos keys found in cosmos_keys.txt for ${selected.name}.`);
      } else {
        logger.error(`No EVM private keys found in private_keys.txt for ${selected.name}.`);
      }
      continue;
    }

    // Get flow configuration
    const { NUMBER_OF_SWAPS, AMOUNT_TO_SWAP } = selected.flow;
    const numSwapsRange = `${NUMBER_OF_SWAPS[0]}-${NUMBER_OF_SWAPS[1]}`;
    const amountRange = `${AMOUNT_TO_SWAP[0]} - ${AMOUNT_TO_SWAP[1]}`;
    const tokenSymbol = isCosmosChain ? (selected.name === 'Osmosis Testnet' ? 'OSMO' : 'ORAI') : 'ETH';

    // Enhanced pre-execution summary
    logger.info(`🔧 Configuration Summary:`);
    logger.info(`   📊 Chain: ${selected.name}`);
    logger.info(`   👛 Wallets: ${keysToUse.length} ${keyType} keys`);
    logger.info(`   🔄 Swaps per wallet: ${numSwapsRange}`);
    logger.info(`   💰 Amount range: ${amountRange} ${tokenSymbol}`);
    logger.info(`   ⚡ Processing mode: Parallel (max ${SETTINGS.THREADS} concurrent)`);
    console.log('');

    // Route testing preview for enhanced automation
    if (isCosmosChain) {
      logger.info(`🔍 Cross-chain routing preview:`);
      if (selected.name === 'Osmosis Testnet') {
        logger.info(`   🌐 Source: Osmosis (OSMO native token)`);
      } else if (selected.name === 'Oraichain Testnet') {
        logger.info(`   🌐 Source: Oraichain (ORAI native token)`);
      }
      logger.info(`   🎯 Targets: MON, STT, EUCLID, USDC, USDT (EVM chains)`);
      logger.info(`   🔗 Bridge: Euclid Virtual Settlement Layer`);
    } else {
      logger.info(`🔍 Same-chain routing preview:`);
      logger.info(`   🎯 Supported pairs: ETH ↔ EUCLID ↔ USDC ↔ MON ↔ STT`);
      logger.info(`   💱 Protocol: Euclid DEX aggregator`);
    }
    console.log('');

    logger.loading(`⏳ Initializing ${selected.name} automation...`);
    await randomDelay(2000, 3000);

    logger.info(`Using ${keysToUse.length} keys for ${selected.name}`);

    // Process wallets in parallel with concurrency limit
    await processInParallel(
      keysToUse,
      SETTINGS.THREADS,
      async (key, walletIndex) => {
        // Generate a unique random delay for each wallet and log it
        const delaySec = getRandomInRange(SETTINGS.RANDOM_INITIALIZATION_PAUSE[0], SETTINGS.RANDOM_INITIALIZATION_PAUSE[1]);
        logger.loading(`[Delay] Waiting ${delaySec}s (Wallet ${walletIndex} initialization)...`);
        await randomDelay(delaySec * 1000, delaySec * 1000, `Wallet ${walletIndex} initialization`);

        // Randomize numSwaps per wallet
        const numSwaps = (selected.flow.NUMBER_OF_SWAPS[0] === selected.flow.NUMBER_OF_SWAPS[1])
          ? selected.flow.NUMBER_OF_SWAPS[0]
          : (typeof getRandomInRange === 'function'
              ? getRandomInRange(selected.flow.NUMBER_OF_SWAPS[0], selected.flow.NUMBER_OF_SWAPS[1])
              : Math.floor(Math.random() * (selected.flow.NUMBER_OF_SWAPS[1] - selected.flow.NUMBER_OF_SWAPS[0] + 1)) + selected.flow.NUMBER_OF_SWAPS[0]);
        
        // Get swap parameters
        const minAmount = selected.flow.AMOUNT_TO_SWAP[0];
        const maxAmount = selected.flow.AMOUNT_TO_SWAP[1];
        const minDelay = SETTINGS.PAUSE_BETWEEN_SWAPS[0];
        const maxDelay = SETTINGS.PAUSE_BETWEEN_SWAPS[1];

        logger.info(`[✓] Processing wallet ${walletIndex}/${keysToUse.length} on ${selected.name} (numSwaps: ${numSwaps})`);
        await selected.process(
          key,
          'random',
          numSwaps,
          minAmount,
          maxAmount,
          minDelay,
          maxDelay,
          false,
          logger
        );
      }
    );

    logger.success(`All wallets processed for ${selected.name}!`);
  }
}

main().catch(error => {
  logger.error(`Fatal error: ${error.message}`);
  rl.close();
});
