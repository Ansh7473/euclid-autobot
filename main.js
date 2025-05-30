import fs from 'fs/promises';
import { ethers } from 'ethers';
import logger from './logger.js';
import { SETTINGS, FLOW, randomDelay, getRandomInRange } from './config.js';
import processArbitrumSwap from './euclid-arbitrum-sepolia.js';
import processBaseSwap from './euclid-base-sepolia.js';
import processEthereumSwap from './euclid-ethereum-sepolia.js';
import processMonadSwap from './euclid-monad.js';
import processMegaethSwap from './euclid-megaeth.js';
import processSomniaSwap from './euclid-somnia.js';

const rl = (await import('readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
const question = async (query) => await rl.question(query);

const readPrivateKeys = async () => {
  try {
    const data = await fs.readFile('private_keys.txt', 'utf8');
    return data
      .split('\n')
      .map(key => key.replace(/\r/g, '').trim())
      .filter(key => key && key.startsWith('0x'));
  } catch (error) {
    logger.error(`Failed to read private_keys.txt: ${error.message}`);
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
  { id: '1', name: 'Arbitrum Sepolia', process: processArbitrumSwap, flow: FLOW.arbitrum },
  { id: '2', name: 'Base Sepolia', process: processBaseSwap, flow: FLOW.base },
  { id: '3', name: 'Ethereum Sepolia', process: processEthereumSwap, flow: FLOW.ethereum_sepolia },
  { id: '4', name: 'Monad', process: processMonadSwap, flow: FLOW.monad },
  { id: '5', name: 'MegaETH', process: processMegaethSwap, flow: FLOW.megaeth },
  { id: '6', name: 'Somnia', process: processSomniaSwap, flow: FLOW.somnia },
];

async function main() {
  logger.banner();
  const privateKeys = await readPrivateKeys();
  if (privateKeys.length === 0) {
    logger.error(`No private keys found.`);
    rl.close();
    return;
  }
  logger.info(`Found ${privateKeys.length} private keys`);

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

    // Process wallets in parallel with concurrency limit
    await processInParallel(
      privateKeys,
      SETTINGS.THREADS,
      async (key, walletIndex) => {
        // Generate a unique random delay for each wallet and log it
        const delaySec = getRandomInRange(SETTINGS.RANDOM_INITIALIZATION_PAUSE[0], SETTINGS.RANDOM_INITIALIZATION_PAUSE[1]);
        logger.loading(`[Initialization] Waiting ${delaySec}s for wallet ${walletIndex}...`);
        await randomDelay(delaySec * 1000, delaySec * 1000, `Wallet ${walletIndex} initialization`);

        // Randomize numSwaps per wallet
        const numSwaps = (selected.flow.NUMBER_OF_SWAPS[0] === selected.flow.NUMBER_OF_SWAPS[1])
          ? selected.flow.NUMBER_OF_SWAPS[0]
          : (typeof getRandomInRange === 'function'
              ? getRandomInRange(selected.flow.NUMBER_OF_SWAPS[0], selected.flow.NUMBER_OF_SWAPS[1])
              : Math.floor(Math.random() * (selected.flow.NUMBER_OF_SWAPS[1] - selected.flow.NUMBER_OF_SWAPS[0] + 1)) + selected.flow.NUMBER_OF_SWAPS[0]);
        // Optionally randomize minAmount/maxAmount per wallet if desired (currently fixed per run)
        const minAmount = selected.flow.AMOUNT_TO_SWAP[0];
        const maxAmount = selected.flow.AMOUNT_TO_SWAP[1];
        const minDelay = SETTINGS.PAUSE_BETWEEN_SWAPS[0];
        const maxDelay = SETTINGS.PAUSE_BETWEEN_SWAPS[1];

        logger.info(`Processing wallet ${walletIndex}/${privateKeys.length} on ${selected.name} (numSwaps: ${numSwaps})`);
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
