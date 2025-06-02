import { DirectSecp256k1HdWallet, DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import { SigningStargateClient, defaultRegistryTypes } from '@cosmjs/stargate';
import { Registry } from '@cosmjs/proto-signing';
import { fromBase64, fromHex } from '@cosmjs/encoding';
import axios from 'axios';
import { readFile } from 'fs/promises';
import { SETTINGS, randomDelay, SHOW_SWAP_PENDING_LOG } from '../config.js';

// Dynamic import for cosmjs-types
let MsgExecuteContract;
let customRegistry;

const config = {
  rpc: 'https://testnet-v2.rpc.orai.io/',
  chainId: 'Oraichain-testnet',
  name: 'Oraichain Testnet',
  explorer: 'https://testnet.scan.orai.io/txs/',
  // Correct Euclid protocol contract address from real transaction
  contractAddress: 'orai1kvjk9m7dk0es35y6ah0k28llllvle3n7xgvh0gh568ta0paf8awshyr6ej',
  // Only native ORAI token for same-chain swaps
  nativeTokens: ['orai'],
  // EVM tokens for cross-chain swaps
  evmTokens: ['euclid', '0g', 'usdc', 'usdt', 'eth', 'stt'],
  chainUid: 'oraichain',
  denom: {
    orai: 'orai'
  },
  prefix: 'orai',
  gasPrice: '0.001orai'
};

// Initialize CosmWasm types and registry
async function initializeCosmWasm() {
  if (!MsgExecuteContract) {
    const cosmwasmTypes = await import('cosmjs-types/cosmwasm/wasm/v1/tx.js');
    MsgExecuteContract = cosmwasmTypes.MsgExecuteContract;
    
    customRegistry = new Registry([
      ...defaultRegistryTypes,
      ["/cosmwasm.wasm.v1.MsgExecuteContract", MsgExecuteContract]
    ]);
  }
  return { MsgExecuteContract, customRegistry };
}

// Helper: read Cosmos private keys
async function readCosmosKeys() {
  try {
    const data = await readFile('data/cosmos_keys.txt', 'utf8');
    return data
      .split('\n')
      .map(line => line.replace(/\r/g, '').trim())
      .filter(line => line && line.startsWith('0x'));
  } catch (error) {
    console.error('Failed to read cosmos_keys.txt:', error.message);
    return [];
  }
}

// Helper: retry
async function retry(fn, retries = 3, delay = 1000) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < retries - 1) await new Promise(res => setTimeout(res, delay));
    }
  }
  throw lastError;
}

const createAxiosInstance = () => {
  return axios.create({
    timeout: 30000,
    headers: {
      'accept': 'application/json, text/plain, */*',
      'content-type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
  });
};

// Create wallet from private key
async function createWallet(privateKey) {
  try {
   
    const cleanKey = privateKey.replace('0x', '');
   
    const keyBytes = fromHex(cleanKey);
    
    
    const wallet = await DirectSecp256k1Wallet.fromKey(keyBytes, config.prefix);
    const accounts = await wallet.getAccounts();
    console.log('DEBUG: Generated address:', accounts[0].address);
    
    return wallet;
  } catch (error) {
    throw new Error(`Failed to create wallet: ${error.message}`);
  }
}

// Lookup route for cross-chain swap
async function lookupRoute(fromToken, toToken, amount, logger) {
  try {
    const axiosInstance = createAxiosInstance();
    
    const params = {
      external: true,
      token_in: fromToken,
      token_out: toToken,
      amount_in: amount.toString(),
      chain_uids: []
    };

    logger.info(`[✓] [${config.name}] Looking up route: ${fromToken} -> ${toToken}, amount: ${amount}`);
    const apiUrl = 'https://testnet.api.euclidprotocol.com/api/v1/routes?limit=10';
    const response = await axiosInstance.post(apiUrl, params);

    logger.debug(`[✓] [${config.name}] Route API response: ${JSON.stringify(response.data, null, 2)}`);

    if (!response.data?.paths || response.data.paths.length === 0) {
      throw new Error(`No routes found for ${fromToken} -> ${toToken}`);
    }

    const bestPath = response.data.paths[0];
    logger.info(`[✓] [${config.name}] Route found: ${bestPath.path[0].route.join(' -> ')}`);
    
    return {
      route: bestPath.path[0].route,
      expectedOutput: bestPath.path[0].amount_out,
      chainUid: 'vsl',
      targetChainUid: 'optimism' // Default for cross-chain swaps
    };
  } catch (error) {
    logger.error(`[✓] [${config.name}] Route lookup error: ${error.message}`);
    if (error.response) {
      logger.error(`[✓] [${config.name}] API Response: ${JSON.stringify(error.response.data, null, 2)}`);
    }
    throw new Error(`Route lookup failed: ${error.message}`);
  }
}

// Execute swap on Osmosis using CosmWasm contract (supporting cross-chain)
async function executeSwap(wallet, routeData, fromToken, toToken, amount, logger, isCrossChain = false, receiverAddress = null) {
  try {
    // Ensure CosmWasm types are initialized
    const { customRegistry: registry } = await initializeCosmWasm();
    
    // Connect to Osmosis testnet with CosmWasm registry
    const client = await SigningStargateClient.connectWithSigner(config.rpc, wallet, {
      gasPrice: config.gasPrice,
      registry: registry
    });

    const accounts = await wallet.getAccounts();
    const senderAddress = accounts[0].address;

    // Get account balances
    const balances = await client.getAllBalances(senderAddress);
    logger.info(`[✓] [${config.name}] Account: ${senderAddress}`);
    logger.info(`[✓] [${config.name}] Balances: ${balances.map(b => `${b.amount} ${b.denom}`).join(', ')}`);

    const fromDenom = fromToken === 'orai' ? 'orai' : fromToken;
    const microAmount = Math.floor(amount * 1e6).toString();

    // Check if we have enough balance (should be ORAI)
    const fromBalance = balances.find(b => b.denom === fromDenom);
    if (!fromBalance || parseInt(fromBalance.amount) < parseInt(microAmount)) {
      throw new Error(`Insufficient ${fromToken} balance: ${fromBalance?.amount || '0'} < ${microAmount}`);
    }

    // Build CosmWasm contract execution message for Euclid swap
    const euclidContract = config.contractAddress;
    const minAmountOut = Math.floor(parseFloat(routeData.expectedOutput) * 0.95).toString();
    
    if (isCrossChain && receiverAddress) {
      logger.info(`[✓] [${config.name}] Cross-chain swap: ${senderAddress} -> ${receiverAddress}`);
    }
    
    // Build swap path from route
    const swaps = [];
    if (routeData.route && routeData.route.length > 1) {
      for (let i = 0; i < routeData.route.length - 1; i++) {
        const tokenIn = routeData.route[i].split(':')[0];
        const tokenOut = routeData.route[i + 1].split(':')[0];
        swaps.push({
          token_in: tokenIn,
          token_out: tokenOut
        });
      }
    }

    // Build cross-chain addresses if needed
    const crossChainAddresses = [];
    if (isCrossChain && receiverAddress) {
      crossChainAddresses.push({
        user: {
          chain_uid: routeData.targetChainUid || 'optimism',
          address: receiverAddress
        },
        limit: {
          less_than_or_equal: routeData.expectedOutput
        }
      });
    }

    // Build metadata
    const meta = {
      asset_in_type: "native",
      releases: isCrossChain ? [{
        dex: "euclid",
        release_address: [{
          chain_uid: routeData.targetChainUid || 'optimism',
          address: receiverAddress,
          amount: routeData.expectedOutput
        }],
        token: toToken,
        amount: ""
      }] : [],
      swaps: {
        path: [{
          route: routeData.route ? routeData.route.map(r => r.split(':')[0]) : [fromToken, toToken],
          dex: "euclid",
          chain_uid: "vsl",
          amount_in: microAmount,
          amount_out: routeData.expectedOutput
        }]
      }
    };

    // Build the CosmWasm execute message payload
    const msgPayload = {
      execute_swap_request: {
        amount_in: microAmount,
        asset_in: {
          token: fromToken,
          token_type: {
            native: {
              denom: fromDenom
            }
          }
        },
        asset_out: toToken,
        cross_chain_addresses: crossChainAddresses,
        meta: JSON.stringify(meta),
        min_amount_out: minAmountOut,
        partner_fee: null,
        swaps: swaps
      }
    };

    const executeSwapMsg = {
      typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
      value: {
        sender: senderAddress,
        contract: euclidContract,
        msg: new TextEncoder().encode(JSON.stringify(msgPayload)),
        funds: [{ denom: fromDenom, amount: microAmount }]
      }
    };

    logger.info(`[✓] [${config.name}] Executing swap: ${amount} ${fromToken} -> ${toToken}${isCrossChain ? ' (Cross-chain)' : ''}`);
    logger.debug(`[✓] [${config.name}] Swap message: ${JSON.stringify(executeSwapMsg, null, 2)}`);

    // Estimate gas
    const gasEstimation = await client.simulate(senderAddress, [executeSwapMsg], '');
    const gasLimit = Math.ceil(gasEstimation * 1.3); // Add 30% buffer

    logger.info(`[✓] [${config.name}] Gas estimate: ${gasEstimation}, using: ${gasLimit}`);

    // Execute transaction
    const result = await client.signAndBroadcast(
      senderAddress,
      [executeSwapMsg],
      {
        amount: [{ denom: 'orai', amount: Math.ceil(gasLimit * 0.001).toString() }],
        gas: gasLimit.toString()
      },
      'Execute Swap'
    );

    if (result.code !== 0) {
      throw new Error(`Transaction failed: ${result.rawLog}`);
    }

    const txHash = result.transactionHash;
    const explorerUrl = `${config.explorer}${txHash}`;
    
    logger.success(`[✓] [${config.name}] ✅ Swap successful!${isCrossChain ? ' (Cross-chain)' : ''}`);
    logger.success(`[✓] [${config.name}] 📊 ${fromToken} -> ${toToken}${receiverAddress ? ` | To: ${receiverAddress}` : ''}`);
    logger.success(`[✓] [${config.name}] 💰 Amount: ${amount}`);
    logger.success(`[✓] [${config.name}] 🔗 TX: ${explorerUrl}`);

    if (SHOW_SWAP_PENDING_LOG[config.chainUid]) {
      logger.loading(`[✓] [${config.name}] ⏳ Confirming transaction...`);
      // Wait for confirmation (Cosmos transactions are typically fast)
      await new Promise(resolve => setTimeout(resolve, 3000));
      logger.success(`[✓] [${config.name}] ✅ Transaction confirmed!`);
    }

    return {
      success: true,
      txHash,
      explorerUrl,
      fromToken,
      toToken,
      amount,
      isCrossChain,
      receiverAddress
    };

  } catch (error) {
    logger.error(`[✓] [${config.name}] ❌ Swap failed: ${error.message}`);
    return {
      success: false,
      error: error.message,
      fromToken,
      toToken,
      amount,
      isCrossChain,
      receiverAddress
    };
  }
}

// Get random token pair for cross-chain swap (ORAI -> EVM tokens)
function getRandomTokenPair() {
  // Always start with ORAI (native token)
  const fromToken = 'orai';
  
  // Select random EVM token as target
  const toToken = config.evmTokens[Math.floor(Math.random() * config.evmTokens.length)];
  
  return [fromToken, toToken];
}

// Main swap process
const processOraichainSwap = async (
  privateKey,
  swapType,
  numSwaps,
  minAmount,
  maxAmount,
  minDelay,
  maxDelay,
  requireConfirmation,
  logger
) => {
  try {
    // Initialize CosmWasm types
    await initializeCosmWasm();
    
    logger.info(`[✓] [${config.name}] 🚀 Starting Osmosis cross-chain swap process...`);
    
    // Create wallet
    const wallet = await createWallet(privateKey);
    const accounts = await wallet.getAccounts();
    const walletAddress = accounts[0].address;
    
    logger.info(`[✓] [${config.name}] 👛 Wallet: ${walletAddress}`);

    // Configuration summary
    logger.info(`[✓] [${config.name}] 📋 Configuration Summary:`);
    logger.info(`[✓] [${config.name}] 🔄 Swap type: ORAI to Random EVM Token (Cross-chain)`);
    logger.info(`[✓] [${config.name}] 📊 Transactions: ${numSwaps}`);
    logger.info(`[✓] [${config.name}] 💰 ORAI per transaction: ${minAmount}–${maxAmount} ORAI (random)`);
    logger.info(`[✓] [${config.name}] ⏱️  Delay range: ${minDelay}–${maxDelay} seconds`);

    if (requireConfirmation) {
      const confirm = await (await import('readline/promises')).createInterface({ input: process.stdin, output: process.stdout }).question(`Continue with these settings for wallet ${walletAddress}? (y/n): `);
      if (confirm.toLowerCase() !== 'y') {
        logger.error(`[✓] [${config.name}] ❌ Cancelled for wallet ${walletAddress}.`);
        return {
          success: false,
          successCount: 0,
          failCount: numSwaps,
          totalSwaps: numSwaps
        };
      }
    } else {
      logger.info(`[✓] [${config.name}] ✅ Auto-continuing for wallet ${walletAddress}`);
    }

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < numSwaps; i++) {
      try {

        // Get random token pair (ORAI -> EVM token)
        const [fromToken, toToken] = getRandomTokenPair();
        logger.info(`[✓] [${config.name}] 🎯 Token pair: ${fromToken} -> ${toToken}`);

        // Random swap amount between minAmount-maxAmount ORAI
        const swapAmount = Math.random() * (3 - 1) + 1;
        logger.info(`[✓] [${config.name}] 💰 Swap amount: ${swapAmount} ${fromToken}`);

        // Lookup cross-chain route
        const routeData = await lookupRoute(fromToken, toToken, Math.floor(swapAmount * 1e6), logger);
        
        // Generate EVM receiver address from private keys
        const evmPrivateKeys = await import('fs/promises')
          .then(fs => fs.readFile('data/private_keys.txt', 'utf8'))
          .then(data => data.split('\n')
            .map(line => line.replace(/\r/g, '').trim())
            .filter(line => line.startsWith('0x')));
        
        const randomEvmKey = evmPrivateKeys[Math.floor(Math.random() * evmPrivateKeys.length)];
        const { ethers } = await import('ethers');
        const evmWallet = new ethers.Wallet(randomEvmKey);
        const receiverAddress = evmWallet.address;

        // Execute cross-chain swap
        const swapResult = await executeSwap(
          wallet,
          routeData,
          fromToken,
          toToken,
          swapAmount,
          logger,
          true, // isCrossChain
          receiverAddress
        );

        if (swapResult.success) {
          successCount++;
          logger.success(`[✓] [${config.name}] ✅ Swap ${i + 1} completed successfully`);
        } else {
          failCount++;
          logger.error(`[✓] [${config.name}] ❌ Swap ${i + 1} failed: ${swapResult.error}`);
        }

        // Wait between swaps
        if (i < numSwaps - 1) {
          const delay = Math.random() * (5000 - 2000) + 2000; // 2-5 seconds
          await new Promise(resolve => setTimeout(resolve, delay));
        }

      } catch (error) {
        failCount++;
        logger.error(`[✓] [${config.name}] ❌ Swap ${i + 1} failed: ${error.message}`);
      }
    }

    // Final summary
    logger.info(`[✓] [${config.name}] 📊 Final Results:`);
    logger.info(`[✓] [${config.name}] ✅ Successful swaps: ${successCount}/${numSwaps}`);
    logger.info(`[✓] [${config.name}] ❌ Failed swaps: ${failCount}/${numSwaps}`);
    logger.info(`[✓] [${config.name}] 🏁 Wallet processing completed`);

    return {
      success: successCount > 0,
      successCount,
      failCount,
      totalSwaps: numSwaps
    };

  } catch (error) {
    logger.error(`[✓] [${config.name}] ❌ Fatal error: ${error.message}`);
    throw error;
  }
};

// Update the cosmos keys import
const cosmosKeys = (await import('fs/promises'))
  .readFile('data/cosmos_keys.txt', 'utf8')
  .then(data => data
    .split('\n')
    .map(line => line.replace(/\r/g, '').trim())
    .filter(line => line && line.length > 0)
  );

export default processOraichainSwap;

