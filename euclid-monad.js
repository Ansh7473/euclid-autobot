import { ethers } from 'ethers';
import axios from 'axios';
import { GraphQLClient } from 'graphql-request';
import logger from './logger.js';
import { SETTINGS, FLOW, randomDelay, SHOW_SWAP_PENDING_LOG } from './config.js';

// Placeholder: Replace with actual Euclid contract address for Monad Testnet
const EUCLID_CONTRACT_ADDRESS = '0xF2401973d404b532E816Fa54f22980CE91dCdd53'; // TODO: Verify this address

// Detect ethers v6
const isEthersV6 = typeof ethers.parseEther === 'function';
const config = {
  rpc: 'https://monad-testnet.drpc.org',
  chainId: 10143,
  name: 'Monad Testnet',
  chainUid: 'monad',
  contract: EUCLID_CONTRACT_ADDRESS,
  explorer: 'https://testnet.monadexplorer.com/tx/',
  tokens: ['mon', 'euclid', 'usdc', 'usdt'],
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
  timeout: 10000,
});

const retry = async (fn, retries = SETTINGS.ATTEMPTS, baseDelay = SETTINGS.PAUSE_BETWEEN_ATTEMPTS[0] * 1000) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
      const delay = baseDelay * Math.pow(2, i);
      logger.loading(`[Monad] Retrying in ${delay / 1000} seconds...`);
      await randomDelay(SETTINGS.PAUSE_BETWEEN_ATTEMPTS[0] * 1000, SETTINGS.PAUSE_BETWEEN_ATTEMPTS[1] * 1000);
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
      .filter(token => token !== 'mon');
  } catch (error) {
    logger.error(`[Monad] Failed to fetch tokens: ${error.message}`);
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
    logger.error(`[Monad] Failed to fetch escrows for ${token}: ${error.message}`);
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
    logger.error(`[Monad] Failed to simulate swap: ${error.message}`);
    return null;
  }
};

const validateTokenRoutes = async (token, chainUids, amountInWei) => {
  try {
    const routesPayload = {
      external: true,
      token_in: 'mon',
      token_out: token,
      amount_in: amountInWei.toString(),
      chain_uids: chainUids,
      intermediate_tokens: config.tokens.filter(t => t !== token && t !== 'mon'),
    };
    const response = await axios.post(config.routesApi, routesPayload, {
      headers: { 'accept': 'application/json', 'content-type': 'application/json', 'Referer': 'https://testnet.euclidswap.io/' },
      timeout: 10000,
    });
    return response.data.paths && response.data.paths.length > 0;
  } catch (error) {
    logger.debug(`[Monad] Route validation failed for ${token}: ${error.message}`);
    return false;
  }
};

const checkSwapStatus = async (txHash, walletAddress, provider, meta) => {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await retry(() =>
        axios.post('https://testnet.api.euclidprotocol.com/api/v1/txn/track/swap', {
          chain: config.chainUid,
          tx_hash: txHash,
          meta: meta ? JSON.stringify(meta) : '',
        }, {
          headers: { 'accept': 'application/json', 'content-type': 'application/json', 'Referer': 'https://testnet.euclidswap.io/' },
          timeout: 10000,
        })
      );
      if (response.data.response.is_completed) {
        logger.success(`[Monad] Swap completed: ${txHash}`);
        return true;
      }
      if (SHOW_SWAP_PENDING_LOG.monad) {
        logger.loading(`[Monad] Swap pending (Attempt ${attempt}/10): ${txHash}`);
      }
    } catch (error) {
      logger.warn(`[Monad] Status check failed: ${error.message}. Verifying on-chain...`);
      try {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (receipt && receipt.status === 1) {
          logger.success(`[Monad] Swap confirmed on-chain: ${txHash}`);
          return true;
        }
      } catch (onChainError) {
        logger.debug(`[Monad] On-chain verification failed: ${onChainError.message}`);
      }
    }
    await randomDelay(30000, 30000);
  }
  logger.error(`[Monad] Swap did not complete after 2 attempts: ${txHash}`);
  return false;
};

const getDynamicGasPrices = async (provider) => {
  try {
    const feeData = await provider.getFeeData();
    const baseFeePerGas = feeData.lastBaseFeePerGas || ethers.parseUnits('0.05', 'gwei');
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || ethers.parseUnits('0.1', 'gwei');

    const maxFeePerGas = baseFeePerGas + maxPriorityFeePerGas + ethers.parseUnits('0.05', 'gwei');
    const cappedMaxFee = maxFeePerGas > ethers.parseUnits('1', 'gwei') ? ethers.parseUnits('1', 'gwei') : maxFeePerGas;
    const cappedPriorityFee = maxPriorityFeePerGas > ethers.parseUnits('0.5', 'gwei')
      ? ethers.parseUnits('0.5', 'gwei')
      : (maxPriorityFeePerGas < ethers.parseUnits('0.05', 'gwei') ? ethers.parseUnits('0.05', 'gwei') : maxPriorityFeePerGas);

    logger.debug(`[Monad] Gas prices: maxFeePerGas=${ethers.formatUnits(cappedMaxFee, 'gwei')} gwei, maxPriorityFeePerGas=${ethers.formatUnits(cappedPriorityFee, 'gwei')} gwei`);
    return {
      maxFeePerGas: cappedMaxFee,
      maxPriorityFeePerGas: cappedPriorityFee,
    };
  } catch (error) {
    logger.warn(`[Monad] Failed to fetch gas prices: ${error.message}. Using defaults.`);
    return {
      maxFeePerGas: ethers.parseUnits('1', 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits('0.1', 'gwei'),
    };
  }
};

const processSwap = async (privateKey, swapType, numTransactions, minEthAmount, maxEthAmount, minDelay, maxDelay, requireConfirmation, logger) => {
  const provider = new ethers.JsonRpcProvider(config.rpc, config.chainId, { staticNetwork: true, timeout: 15000 });
  const wallet = new ethers.Wallet(privateKey, provider);
  const walletAddress = wallet.address;
  logger.info(`[Monad] Connected to wallet: ${walletAddress}`);
  logger.info(`[Monad] Network: ${config.name} (Chain ID: ${config.chainId})`);

  if (config.contract === '0x0000000000000000000000000000000000000000') {
    logger.error(`[Monad] Invalid contract address. Please update EUCLID_CONTRACT_ADDRESS in euclid-monad.js.`);
    return false;
  }

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
    logger.error(`[Monad] Insufficient MON. Required: ${ethers.formatEther(totalRequiredEth)} MON, Available: ${ethers.formatEther(balance)} MON`);
    return false;
  }

  logger.warn(`[Monad] Summary for wallet ${walletAddress}:`);
  logger.step(`Swap type: MON to Random Token`);
  logger.step(`Transactions: ${numTransactions}`);
  logger.step(`MON per transaction: ${minEthAmount}–${maxEthAmount} MON (random)`);
  logger.step(`Total MON (incl. gas): ${ethers.formatEther(totalRequiredEth)} MON`);
  logger.step(`Global delay between transactions: ${minDelay}–${maxDelay} seconds`);

  if (requireConfirmation) {
    const confirm = await (await import('readline/promises')).createInterface({ input: process.stdin, output: process.stdout }).question(`[Monad] Continue with these settings for wallet ${walletAddress}? (y/n): `);
    if (confirm.toLowerCase() !== 'y') {
      logger.error(`[Monad] Cancelled for wallet ${walletAddress}.`);
      return false;
    }
  } else {
    logger.step(`[Monad] Auto-continuing for wallet ${walletAddress}`);
  }

  const tokens = await fetchAvailableTokens();
  if (tokens.length === 0) {
    logger.error(`[Monad] No tokens available on ${config.name}.`);
    return false;
  }
  logger.step(`[Monad] Available tokens: ${tokens.join(', ')}`);

  const validTokens = [];
  for (const token of config.tokens) {
    const balance = await fetchEscrows(token);
    logger.step(`[Monad] ${token.toUpperCase()} escrow: ${balance}`);
    if (balance > 0) {
      validTokens.push(token);
    }
  }

  if (validTokens.length === 0) {
    logger.error(`[Monad] No tokens with sufficient escrow balance on ${config.name}.`);
    return false;
  }

  const tokenChainUids = {
    mon: 'monad',
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
    logger.error(`[Monad] No supported tokens with valid routes on ${config.name}.`);
    return false;
  }
  logger.step(`[Monad] Supported target tokens: ${supportedTargetTokens.join(', ')}`);

  let gasLimit = 2500000;
  for (let i = 0; i < numTransactions; i++) {
    const ethAmount = ethAmounts[i];
    const amountInWei = ethers.parseEther(ethAmount);
    let currentToken = supportedTargetTokens[Math.floor(Math.random() * supportedTargetTokens.length)];
    let currentChainUid = tokenChainUids[currentToken] || 'vsl';
    logger.step(`[Monad] Selected random token: ${currentToken} (chain: ${currentChainUid})`);

    let attempt = 0;
    const maxAttempts = supportedTargetTokens.length;

    while (attempt < maxAttempts) {
      logger.loading(`[Monad] Transaction ${i + 1}/${numTransactions} (MON to ${currentToken}, ${ethAmount} MON) for wallet ${walletAddress}:`);

      try {
        const routesPayload = {
          external: true,
          token_in: 'mon',
          token_out: currentToken,
          amount_in: amountInWei.toString(),
          chain_uids: [config.chainUid, 'vsl'],
          intermediate_tokens: supportedTargetTokens.filter(t => t !== currentToken && t !== 'mon'),
        };

        logger.step(`[Monad] Requesting route: MON -> ${currentToken}`);
        const routesResponse = await retry(() =>
          axios.post(config.routesApi, routesPayload, {
            headers: { 'accept': 'application/json', 'content-type': 'application/json', 'Referer': 'https://testnet.euclidswap.io/' },
            timeout: 10000,
          })
        );

        const routes = routesResponse.data.paths;
        if (!routes || routes.length === 0) {
          logger.error(`[Monad] No routes found for MON to ${currentToken}.`);
          break;
        }

        const selectedRouteIndex = Math.floor(Math.random() * routes.length);
        const selectedRouteObj = routes[selectedRouteIndex].path[0];
        const selectedRoute = selectedRouteObj.route;
        const amountOut = selectedRouteObj.amount_out;
        const chainUidForAddress = selectedRouteObj.route[selectedRouteObj.route.length - 1] || currentChainUid;
        logger.step(`[Monad] Found ${routes.length} routes, selected: ${selectedRoute.join(' -> ')}, amount_out: ${amountOut}`);

        let simulatedAmountOut = await simulateSwap('mon', amountInWei.toString(), currentToken, selectedRoute);
        let usedAmountOut = simulatedAmountOut;
        if (!simulatedAmountOut || simulatedAmountOut === '0' || simulatedAmountOut === 0) {
          logger.warn(`[Monad] Swap simulation failed or returned zero for ${selectedRoute.join(' -> ')}. Falling back to route API's amount_out: ${amountOut}`);
          usedAmountOut = amountOut;
        }
        if (!usedAmountOut || usedAmountOut === '0' || usedAmountOut === 0) {
          logger.error(`[Monad] Both simulation and route API returned zero for ${selectedRoute.join(' -> ')}. Trying next route/token...`);
          attempt++;
          if (attempt < maxAttempts) {
            currentToken = supportedTargetTokens[Math.floor(Math.random() * supportedTargetTokens.length)];
            currentChainUid = tokenChainUids[currentToken] || 'vsl';
            logger.warn(`[Monad] Retrying with fallback token: ${currentToken}`);
            continue;
          } else {
            logger.error(`[Monad] All routes/tokens failed for this transaction.`);
            break;
          }
        }

        const slippage = 0.05;
        const minAmountOut = Math.floor(parseInt(usedAmountOut) * (1 - slippage)).toString();

        // Build swapPayload using all available fields from selectedRouteObj
        const swapPayload = {
          amount_in: selectedRouteObj.amount_in,
          asset_in: { token: 'mon', token_type: { __typename: 'NativeTokenType', native: { __typename: 'NativeToken', denom: 'mon' } } },
          slippage: '500',
          cross_chain_addresses: [{ user: { address: walletAddress, chain_uid: chainUidForAddress }, limit: { less_than_or_equal: minAmountOut } }],
          partnerFee: { partner_fee_bps: 10, recipient: walletAddress },
          sender: { address: walletAddress, chain_uid: config.chainUid },
          swap_path: {
            path: [
              {
                ...selectedRouteObj,
                amount_in: selectedRouteObj.amount_in,
                amount_out: minAmountOut,
              }
            ],
            ...(selectedRouteObj.total_price_impact ? { total_price_impact: selectedRouteObj.total_price_impact } : {}),
          },
          timeout: '60',
        };

        logger.debug(`[Monad] Swap payload: ${JSON.stringify(swapPayload)}`);

        // Call swap API to get swapResponse
        const swapResponse = await retry(() =>
          axios.post(config.swapApi, swapPayload, {
            headers: { 'accept': 'application/json', 'content-type': 'application/json', 'Referer': 'https://testnet.euclidswap.io/' },
            timeout: 10000,
          })
        );

        let txData = swapResponse.data.msgs?.[0]?.data;
        if (!txData) {
          logger.error(`[Monad] Calldata missing for ${selectedRoute.join(' -> ')}.`);
          break;
        }

        logger.debug(`[Monad] Transaction data: ${txData.slice(0, 50)}...`);

        let tx = {
          to: config.contract,
          data: txData,
          value: BigInt(selectedRouteObj.amount_in), // Set value to swap amount for native token swaps
        };
        logger.debug(`[Monad] Transaction value (msg.value): ${tx.value.toString()}`);

        // Dynamically set maxFeePerGas and maxPriorityFeePerGas for Monad
        try {
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
          logger.warn(`[Monad] Failed to fetch base fee: ${feeError.message}. Using default gas fees.`);
          const fallback = ethers.parseUnits('2', 'gwei');
          tx.maxPriorityFeePerGas = fallback;
          tx.maxFeePerGas = fallback;
        }
        // Estimate and cap gasLimit
        try {
          const gasEstimate = await provider.estimateGas(tx);
          tx.gasLimit = (gasEstimate * 120n) / 100n;
          if (tx.gasLimit > 10000000n) tx.gasLimit = 10000000n; // Cap to Monad max
        } catch (gasError) {
          logger.warn(`[Monad] Gas estimation failed. Using default: 10000000`);
          tx.gasLimit = 10000000n;
        }

        // SKIP on-chain simulation for Monad, always send the transaction
        // try {
        //   logger.debug(`[Monad] Simulating tx: to=${tx.to}, value=${tx.value.toString()}, data=${tx.data.slice(0, 50)}...`);
        //   await provider.call(tx);
        // } catch (simulationError) {
        //   logger.error(`[Monad] Simulation failed: ${simulationError.reason || simulationError.message || 'Unknown error'}`);
        //   break;
        // }

        const txResponse = await wallet.sendTransaction(tx);
        logger.info(`[Monad] Transaction sent! Hash: ${txResponse.hash}`);

        logger.loading(`[Monad] Waiting for confirmation...`);
        const receipt = await txResponse.wait();

        if (receipt.status === 1) {
          logger.success(`[Monad] Transaction successful! Gas used: ${receipt.gasUsed}`);
          await retry(() =>
            axios.post(config.trackApi, {
              chain_uid: config.chainUid,
              tx_hash: txResponse.hash,
              wallet_address: walletAddress,
              referral_code: 'EUCLIDEAN301040',
              type: 'swap',
            }, { headers: { 'accept': 'application/json', 'content-type': 'application/json', 'Referer': 'https://testnet.euclidswap.io/' } })
          );
          logger.success(`[Monad] Transaction tracked. View: ${config.explorer}${txResponse.hash}`);
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
          logger.error(`[Monad] Transaction failed.`);
          break;
        }
      } catch (error) {
        logger.error(`[Monad] Error: ${error.message}`);
      }

      attempt++;
      if (attempt < maxAttempts) {
        currentToken = supportedTargetTokens[Math.floor(Math.random() * supportedTargetTokens.length)];
        currentChainUid = tokenChainUids[currentToken] || 'vsl';
        logger.warn(`[Monad] Retrying with fallback token: ${currentToken}`);
      }
    }

    if (i < numTransactions - 1) {
      const delay = (minDelay + Math.random() * (maxDelay - minDelay)) * 1000;
      logger.loading(`[Monad] Waiting ${Math.round(delay / 1000)} seconds before next transaction...`);
      await randomDelay(SETTINGS.PAUSE_BETWEEN_SWAPS[0] * 1000, SETTINGS.PAUSE_BETWEEN_SWAPS[1] * 1000);
    }
  }

  logger.success(`[Monad] All transactions completed for wallet ${walletAddress}!`);
  return true;
};

export default processSwap;