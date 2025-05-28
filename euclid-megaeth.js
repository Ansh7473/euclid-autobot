import { ethers } from 'ethers';
import axios from 'axios';
import { GraphQLClient } from 'graphql-request';
import logger from './logger.js';
import { SETTINGS, FLOW, randomDelay, SHOW_SWAP_PENDING_LOG } from './config.js';
// Detect ethers v6
const isEthersV6 = typeof ethers.parseEther === 'function';
const config = {
  rpc: 'https://carrot.megaeth.com/rpc',
  chainId: 6342,
  name: 'MEGA Testnet',
  chainUid: 'megaeth',
  contract: '', // TODO: Add valid contract address for Euclid Protocol
  explorer: 'https://megaexplorer.xyz/tx/',
  tokens: ['eth', 'euclid', 'usdc', 'usdt'],
  graphqlApi: 'https://testnet.api.euclidprotocol.com/graphql',
  routesApi: 'https://testnet.api.euclidprotocol.com/api/v1/routes?limit=10',
  swapApi: 'https://testnet.api.euclidprotocol.com/api/v1/execute/astro/swap',
  trackApi: 'https://testnet.euclidswap.io/api/intract-track',
};

const graphqlClient = new GraphQLClient(config.graphqlApi, {
  headers: {
    accept: 'application/json',
    'content-type': 'application/json',
  },
  timeout: 5000,
});

const retry = async (fn, retries = SETTINGS.ATTEMPTS, baseDelay = SETTINGS.PAUSE_BETWEEN_ATTEMPTS[0] * 1000) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
      const delay = baseDelay * Math.pow(2, i);
      logger.loading(`[MegaETH] Retrying in ${delay / 1000} seconds...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

const fetchAvailableTokens = async () => {
  const query = `
    query CODEGEN_GENERATED_TOKEN_TOKEN_METADATAS($token_token_metadatas_chain_uids: [String!], $token_token_metadatas_limit: Int, $token_token_metadatas_verified: Boolean) {
      token {
        token_metadatas(chain_uids: $token_token_metadatas_chain_uids, limit: $token_token_metadatas_limit, verified: $token_token_metadatas_verified) {
          tokenId
          chain_uids
          __typename
        }
        __typename
      }
    }
  `;
  try {
    const variables = {
      token_token_metadatas_limit: 1000,
      token_token_metadatas_verified: true,
      token_token_metadatas_chain_uids: [config.chainUid],
    };
    const response = await graphqlClient.request(query, variables);
    return response.token.token_metadatas
      .filter(metadata => metadata.chain_uids.includes(config.chainUid))
      .map(metadata => metadata.tokenId)
      .filter(token => token !== 'eth');
  } catch (error) {
    logger.error(`[MegaETH] Failed to fetch tokens: ${error.message}`);
    return [];
  }
};

const fetchEscrows = async (token) => {
  const query = `
    query Escrows($token: String!) {
      router {
        escrows(token: $token) {
          chain_uid
          balance
          chain_id
        }
      }
    }
  `;
  try {
    const response = await graphqlClient.request(query, { token });
    const escrow = response.router.escrows.find(e => e.chain_uid === config.chainUid);
    return escrow ? parseInt(escrow.balance) : 0;
  } catch (error) {
    logger.error(`[MegaETH] Failed to fetch escrows for ${token}: ${error.message}`);
    return 0;
  }
};

const simulateSwap = async (assetIn, amountIn, assetOut, swaps) => {
  const query = `
    query Simulate_swap($assetIn: String!, $amountIn: String!, $assetOut: String!, $minAmountOut: String!, $swaps: [String!]) {
      router {
        simulate_swap(asset_in: $assetIn, amount_in: $amountIn, asset_out: $assetOut, min_amount_out: $minAmountOut, swaps: $swaps) {
          amount_out
          asset_out
        }
      }
    }
  `;
  try {
    const response = await graphqlClient.request(query, {
      assetIn,
      amountIn,
      assetOut,
      minAmountOut: '1',
      swaps,
    });
    return response.router.simulate_swap.amount_out;
  } catch (error) {
    logger.error(`[MegaETH] Failed to simulate swap: ${error.message}`);
    return null;
  }
};

const validateTokenRoutes = async (token, chainUids, amountInWei) => {
  try {
    const routesPayload = {
      external: true,
      token_in: 'eth',
      token_out: token,
      amount_in: amountInWei.toString(),
      chain_uids: chainUids,
      intermediate_tokens: config.tokens.filter(t => t !== token && t !== 'eth'),
    };
    const response = await axios.post(config.routesApi, routesPayload, {
      headers: { 'accept': 'application/json', 'content-type': 'application/json', 'Referer': 'https://testnet.euclidswap.io/' },
      timeout: 5000,
    });
    return response.data.paths && response.data.paths.length > 0;
  } catch (error) {
    logger.debug(`[MegaETH] Route validation failed for ${token}: ${error.message}`);
    return false;
  }
};

const checkSwapStatus = async (txHash, walletAddress, provider, meta) => {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const response = await retry(() =>
        axios.post('https://testnet.api.euclidprotocol.com/api/v1/txn/track/swap', {
          chain: config.chainUid,
          tx_hash: txHash,
          meta: meta ? JSON.stringify(meta) : '',
        }, {
          headers: { 'accept': 'application/json', 'content-type': 'application/json', 'Referer': 'https://testnet.euclidswap.io/' },
          timeout: 5000,
        })
      );
      if (response.data.response.is_completed) {
        logger.success(`[MegaETH] Swap completed: ${txHash}`);
        return true;
      }
      if (SHOW_SWAP_PENDING_LOG.megaeth) {
        logger.loading(`[MegaETH] Swap pending (Attempt ${attempt}/10): ${txHash}`);
      }
    } catch (error) {
      logger.warn(`[MegaETH] Status check failed: ${error.message}. Verifying on-chain...`);
      try {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (receipt && receipt.status === 1) {
          logger.success(`[MegaETH] Swap confirmed on-chain: ${txHash}`);
          return true;
        }
      } catch (onChainError) {
        logger.debug(`[MegaETH] On-chain verification failed: ${onChainError.message}`);
      }
    }
    await randomDelay(30000, 30000); // 30 seconds fixed delay for status check
  }
  logger.error(`[MegaETH] Swap did not complete after 10 attempts: ${txHash}`);
  return false;
};

const processSwap = async (privateKey, swapType, numTransactions, minEthAmount, maxEthAmount, minDelay, maxDelay, requireConfirmation, logger) => {
  const provider = new ethers.JsonRpcProvider(config.rpc, config.chainId);
  const wallet = new ethers.Wallet(privateKey.replace(/\r/g, '').trim(), provider);
  const walletAddress = wallet.address;
  logger.info(`[MegaETH] Connected to wallet: ${walletAddress}`);
  logger.info(`[MegaETH] Network: ${config.name} (Chain ID: ${config.chainId})`);

  const ethAmounts = Array(numTransactions).fill(0).map(() => (minEthAmount + Math.random() * (maxEthAmount - minEthAmount)).toFixed(18));

  const gasEstimatePerTx = ethers.parseEther('0.00009794');
  let totalRequiredEth = BigInt(0);
  for (const ethAmount of ethAmounts) {
    const requiredEth = ethers.parseEther(ethAmount);
    const totalPerTx = requiredEth + gasEstimatePerTx;
    totalRequiredEth += totalPerTx;
  }

  const balance = await provider.getBalance(walletAddress);
  if (balance < totalRequiredEth) {
    logger.error(`[MegaETH] Insufficient ETH. Required: ${ethers.formatEther(totalRequiredEth)} ETH, Available: ${ethers.formatEther(balance)} ETH`);
    return false;
  }

  logger.warn(`[MegaETH] Summary for wallet ${walletAddress}:`);
  logger.step(`Swap type: ETH to Random Token`);
  logger.step(`Transactions: ${numTransactions}`);
  logger.step(`ETH per transaction: ${minEthAmount}–${maxEthAmount} ETH (random)`);
  logger.step(`Total ETH (incl. gas): ${ethers.formatEther(totalRequiredEth)} ETH`);
  logger.step(`Global delay between transactions: ${minDelay}–${maxDelay} seconds`);

  if (requireConfirmation) {
    const confirm = await (await import('readline/promises')).createInterface({ input: process.stdin, output: process.stdout }).question(`[MegaETH] Continue with these settings for wallet ${walletAddress}? (y/n): `);
    if (confirm.toLowerCase() !== 'y') {
      logger.error(`[MegaETH] Cancelled for wallet ${walletAddress}.`);
      return false;
    }
  } else {
    logger.step(`[MegaETH] Auto-continuing for wallet ${walletAddress}`);
  }

  const tokens = await fetchAvailableTokens();
  if (tokens.length === 0) {
    logger.error(`[MegaETH] No tokens available on ${config.name}.`);
    return false;
  }
  logger.step(`[MegaETH] Available tokens: ${tokens.join(', ')}`);

  const validTokens = [];
  for (const token of config.tokens) {
    const balance = await fetchEscrows(token);
    logger.step(`[MegaETH] ${token.toUpperCase()} escrow: ${balance}`);
    if (balance > 0) {
      validTokens.push(token);
    }
  }

  if (validTokens.length === 0) {
    logger.error(`[MegaETH] No tokens with sufficient escrow balance on ${config.name}.`);
    return false;
  }

  const tokenChainUids = {
    eth: 'megaeth',
    euclid: 'optimism',
    usdc: 'base',
    usdt: 'base',
  };

  const supportedTargetTokens = [];
  for (const token of config.tokens) {
    const amountInWei = ethers.parseEther(minEthAmount.toString());
    if (await validateTokenRoutes(token, [config.chainUid, 'vsl'], amountInWei)) {
      supportedTargetTokens.push(token);
    }
  }

  if (supportedTargetTokens.length === 0) {
    logger.error(`[MegaETH] No supported tokens with valid routes on ${config.name}.`);
    return false;
  }
  logger.step(`[MegaETH] Supported target tokens: ${supportedTargetTokens.join(', ')}`);

  let gasLimit = 2000000000; // 2 Giga gas, per MegaETH specs
  for (let i = 0; i < numTransactions; i++) {
    const ethAmount = ethAmounts[i];
    const amountInWei = ethers.parseEther(ethAmount);
    let currentToken = supportedTargetTokens[Math.floor(Math.random() * supportedTargetTokens.length)];
    let currentChainUid = tokenChainUids[currentToken] || 'vsl';
    logger.step(`[MegaETH] Selected random token: ${currentToken} (chain: ${currentChainUid})`);

    let attempt = 0;
    const maxAttempts = supportedTargetTokens.length;

    while (attempt < maxAttempts) {
      logger.loading(`[MegaETH] Transaction ${i + 1}/${numTransactions} (ETH to ${currentToken}, ${ethAmount} ETH) for wallet ${walletAddress}:`);

      try {
        const routesPayload = {
          external: true,
          token_in: 'eth',
          token_out: currentToken,
          amount_in: amountInWei.toString(),
          chain_uids: [config.chainUid, 'vsl'],
          intermediate_tokens: supportedTargetTokens.filter(t => t !== currentToken && t !== 'eth'),
        };

        logger.step(`[MegaETH] Requesting route: ETH -> ${currentToken}`);
        const routesResponse = await retry(() =>
          axios.post(config.routesApi, routesPayload, {
            headers: { 'accept': 'application/json', 'content-type': 'application/json', 'Referer': 'https://testnet.euclidswap.io/' },
            timeout: 5000,
          })
        );

        const routes = routesResponse.data.paths;
        if (!routes || routes.length === 0) {
          logger.error(`[MegaETH] No routes found for ETH to ${currentToken}.`);
          break;
        }

        const selectedRouteIndex = Math.floor(Math.random() * routes.length);
        const selectedRoute = routes[selectedRouteIndex].path[0].route;
        const amountOut = routes[selectedRouteIndex].path[0].amount_out;
        logger.step(`[MegaETH] Found ${routes.length} routes, selected: ${selectedRoute.join(' -> ')}, amount_out: ${amountOut}`);

        const simulatedAmountOut = await simulateSwap('eth', amountInWei.toString(), currentToken, selectedRoute);
        if (!simulatedAmountOut) {
          logger.error(`[MegaETH] Swap simulation failed for ${selectedRoute.join(' -> ')}.`);
          break;
        }

        const slippage = 0.05;
        const minAmountOut = Math.floor(parseInt(simulatedAmountOut) * (1 - slippage)).toString();

        const swapPayload = {
          amount_in: amountInWei.toString(),
          asset_in: { token: 'eth', token_type: { __typename: 'NativeTokenType', native: { __typename: 'NativeToken', denom: 'eth' } } },
          slippage: '500',
          cross_chain_addresses: [{ user: { address: walletAddress, chain_uid: currentChainUid }, limit: { less_than_or_equal: minAmountOut } }],
          partnerFee: { partner_fee_bps: 10, recipient: walletAddress },
          sender: { address: walletAddress, chain_uid: config.chainUid },
          swap_path: { path: [{ route: selectedRoute, dex: 'euclid', amount_in: amountInWei.toString(), amount_out: minAmountOut }] },
          timeout: '60',
        };

        const swapResponse = await retry(() =>
          axios.post(config.swapApi, swapPayload, {
            headers: { 'accept': 'application/json', 'content-type': 'application/json', 'Referer': 'https://testnet.euclidswap.io/' },
            timeout: 5000,
          })
        );

        let txData = swapResponse.data.msgs?.[0]?.data;
        if (!txData) {
          logger.error(`[MegaETH] Calldata missing for ${selectedRoute.join(' -> ')}.`);
          break;
        }

        let tx = {
          to: config.contract || '0x0000000000000000000000000000000000000000', // Placeholder
          value: amountInWei,
          data: txData,
          nonce: await provider.getTransactionCount(walletAddress, 'pending'),
        };
        // Dynamically set maxFeePerGas and maxPriorityFeePerGas for MegaETH
        try {
          // Only fetch block header, not full block (fixes 'full block not allowed' error)
          const latestBlock = await provider.getBlock('latest', false);
          const baseFee = latestBlock.baseFeePerGas || (latestBlock.baseFeePerGas === 0 ? 0 : null);
          // Use a reasonable priority fee (e.g., 1 gwei)
          const priorityFee = ethers.parseUnits('1', 'gwei');
          if (baseFee !== null && baseFee !== undefined) {
            tx.maxPriorityFeePerGas = priorityFee;
            tx.maxFeePerGas = baseFee + priorityFee;
          } else {
            // fallback to 2 gwei if baseFee is not available
            tx.maxPriorityFeePerGas = priorityFee;
            tx.maxFeePerGas = ethers.parseUnits('2', 'gwei');
          }
        } catch (feeError) {
          logger.warn(`[MegaETH] Failed to fetch base fee: ${feeError.message}. Using default gas fees.`);
          const fallback = ethers.parseUnits('2', 'gwei');
          tx.maxPriorityFeePerGas = fallback;
          tx.maxFeePerGas = fallback;
        }
        // Estimate and cap gasLimit
        try {
          const gasEstimate = await provider.estimateGas(tx);
          tx.gasLimit = (gasEstimate * 120n) / 100n;
          if (tx.gasLimit > 10000000n) tx.gasLimit = 10000000n; // Cap to MegaETH max
        } catch (gasError) {
          logger.warn(`[MegaETH] Gas estimation failed. Using default: 10000000`);
          tx.gasLimit = 10000000n;
        }

        try {
          await provider.call(tx);
        } catch (simulationError) {
          logger.error(`[MegaETH] Simulation failed: ${simulationError.reason || simulationError.message}`);
          break;
        }

        const txResponse = await wallet.sendTransaction(tx);
        logger.info(`[MegaETH] Transaction sent! Hash: ${txResponse.hash}`);

        logger.loading(`[MegaETH] Waiting for confirmation...`);
        const receipt = await txResponse.wait();

        if (receipt.status === 1) {
          logger.success(`[MegaETH] Transaction successful! Gas used: ${receipt.gasUsed}`);
          await retry(() =>
            axios.post(config.trackApi, {
              chain_uid: config.chainUid,
              tx_hash: txResponse.hash,
              wallet_address: walletAddress,
              referral_code: 'EUCLIDEAN301040',
              type: 'swap',
            }, { headers: { 'accept': 'application/json', 'content-type': 'application/json', 'Referer': 'https://testnet.euclidswap.io/' } })
          );
          logger.success(`[MegaETH] Transaction tracked. View: ${config.explorer}${txResponse.hash}`);

          // Build meta payload for swap tracking
          const meta = {
            asset_in_type: 'native',
            releases: [
              {
                dex: 'euclid',
                release_address: [
                  {
                    chain_uid: currentChainUid,
                    address: walletAddress,
                    amount: minAmountOut
                  }
                ],
                token: currentToken,
                amount: ''
              }
            ],
            swaps: {
              path: [
                {
                  route: selectedRoute,
                  dex: 'euclid',
                  chain_uid: 'vsl',
                  amount_in: amountInWei.toString(),
                  amount_out: minAmountOut
                }
              ]
            }
          };

          await checkSwapStatus(txResponse.hash, walletAddress, provider, meta);
          break;
        } else {
          logger.error(`[MegaETH] Transaction failed.`);
          break;
        }
      } catch (error) {
        logger.error(`[MegaETH] Error: ${error.message}`);
      }

      attempt++;
      if (attempt < maxAttempts) {
        currentToken = supportedTargetTokens[Math.floor(Math.random() * supportedTargetTokens.length)];
        currentChainUid = tokenChainUids[currentToken] || 'vsl';
        logger.warn(`[MegaETH] Retrying with fallback token: ${currentToken}`);
      }
    }

    if (i < numTransactions - 1) {
      const delay = (minDelay + Math.random() * (maxDelay - minDelay)) * 1000;
      logger.loading(`[MegaETH] Waiting ${Math.round(delay / 1000)} seconds before next transaction...`);
      await randomDelay(SETTINGS.PAUSE_BETWEEN_SWAPS[0] * 1000, SETTINGS.PAUSE_BETWEEN_SWAPS[1] * 1000);
    }
  }

  logger.success(`[MegaETH] All transactions completed for wallet ${walletAddress}!`);
  return true;
};

async function main() {
  const privateKeys = (await import('fs/promises')).readFile('private_keys.txt', 'utf8').then(data => data.split('\n').filter(x => x.startsWith('0x')));
  for (const key of await privateKeys) {
    const numSwaps = FLOW.megaeth.NUMBER_OF_SWAPS[0] + Math.floor(Math.random() * (FLOW.megaeth.NUMBER_OF_SWAPS[1] - FLOW.megaeth.NUMBER_OF_SWAPS[0] + 1));
    const minAmount = FLOW.megaeth.AMOUNT_TO_SWAP[0];
    const maxAmount = FLOW.megaeth.AMOUNT_TO_SWAP[1];
    const minDelay = SETTINGS.PAUSE_BETWEEN_SWAPS[0];
    const maxDelay = SETTINGS.PAUSE_BETWEEN_SWAPS[1];
    await processSwap(key, 'random', numSwaps, minAmount, maxAmount, minDelay, maxDelay, false, logger);
  }
}


export default processSwap;