import { ethers } from 'ethers';
import axios from 'axios';
import { GraphQLClient } from 'graphql-request';
import logger from '../logger.js';
import { SETTINGS, FLOW, randomDelay, SHOW_SWAP_PENDING_LOG, getRandomInRange } from '../config.js';
// Detect ethers v6
const isEthersV6 = typeof ethers.parseEther === 'function';
const config = {
  rpc: 'https://dream-rpc.somnia.network', // Correct Somnia RPC
  chainId: 50312,
  name: 'Somnia Testnet',
  chainUid: 'somnia',
  contract: '0x9a4df80e1F49b605003d09c53FD895F99B792929',
  explorer: 'https://somnia-testnet.socialscan.io/tx/',
  tokens: ['stt', 'euclid', 'usdc', 'usdt'],
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
  timeout: 8000,
});

// Add timeout wrapper for GraphQL requests
const graphqlRequest = async (query, variables, timeoutMs = 20000) => {
  return Promise.race([
    graphqlClient.request(query, variables),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('GraphQL request timeout')), timeoutMs)
    )
  ]);
};

// Improved retry with 429 handling
const retry = async (fn, retries = SETTINGS.ATTEMPTS, baseDelay = SETTINGS.PAUSE_BETWEEN_ATTEMPTS[0] * 1000) => {
  let delay = baseDelay;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      const is429 = error.response && error.response.status === 429;
      if (i === retries - 1) throw error;
      // Handle timeout specifically with longer delay
      if (error.code === 'ECONNABORTED') {
        const timeoutDelay = baseDelay * Math.pow(2, i) * 2; // Double delay for timeouts
        logger.info(`[${config.name}] ⏳ Request timeout, retrying in ${timeoutDelay / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, timeoutDelay));
      }
      if (is429) {
        let retryAfter = error.response.headers['retry-after'];
        if (retryAfter) {
          // retry-after can be seconds or a date
          const seconds = isNaN(retryAfter) ? 10 : parseInt(retryAfter);
          delay = Math.min(seconds * 1000, 30000); // cap at 30s
        } else {
          delay = Math.min(delay * 2, 30000); // exponential backoff, cap at 30s
        }
        logger.warn(`[${config.name}] ⚠️  429 received. Retrying in ${delay / 1000} seconds...`);
      } else {
        delay = Math.min(delay * 1.5, 15000); // gentler backoff for other errors
        logger.info(`[${config.name}] 🔄 Retrying in ${delay / 1000} seconds...`);
      }
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
      .filter(token => token !== 'stt');
  } catch (error) {
    logger.error(`[${config.name}] ❌ Failed to fetch tokens: ${error.message}`);
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
    const response = await graphqlRequest(query, { token }, 15000);
    const escrow = response.router.escrows.find(e => e.chain_uid === config.chainUid);
    return escrow ? parseInt(escrow.balance) : 0;
  } catch (error) {
    logger.error(`[${config.name}] ❌ Failed to fetch escrows for ${token}: ${error.message}`);
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
    const response = await graphqlRequest(query, {
      assetIn,
      amountIn,
      assetOut,
      minAmountOut: '1',
      swaps,
    }, 15000);
    return response.router.simulate_swap.amount_out;
  } catch (error) {
    logger.error(`[${config.name}] ❌ Failed to simulate swap: ${error.message}`);
    return null;
  }
};

const validateTokenRoutes = async (token, chainUids, amountInWei) => {
  try {
    const routesPayload = {
      external: true,
      token_in: 'stt',
      token_out: token,
      amount_in: amountInWei.toString(),
      chain_uids: chainUids,
      intermediate_tokens: config.tokens.filter(t => t !== token && t !== 'stt'),
    };
    const response = await axios.post(config.routesApi, routesPayload, {
      headers: { 'accept': 'application/json', 'content-type': 'application/json', 'Referer': 'https://testnet.euclidswap.io/' },
      timeout: 8000,
    });
    return response.data.paths && response.data.paths.length > 0;
  } catch (error) {
    logger.debug(`[${config.name}] Route validation failed for ${token}: ${error.message}`);
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
          headers: {
            'accept': 'application/json',
            'content-type': 'application/json',
            'Referer': 'https://testnet.euclidswap.io/'
          },
          timeout: 8000,
        })
      );
      if (response.data.response.is_completed) {
        logger.success(`[${config.name}] ✅ Swap completed: ${txHash}`);
        return true;
      }
      if (SHOW_SWAP_PENDING_LOG.somnia) {
        logger.info(`[${config.name}] ⏳ Swap pending (Attempt ${attempt}/10): ${txHash}`);
      }
    } catch (error) {
      logger.warn(`[${config.name}] ⚠️  Status check failed: ${error.message}. Verifying on-chain...`);
      try {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (receipt && receipt.status === 1) {
          logger.success(`[${config.name}] ✅ Swap confirmed on-chain: ${txHash}`);
          return true;
        }
      } catch (onChainError) {
        logger.debug(`[${config.name}] On-chain verification failed: ${onChainError.message}`);
      }
    }
    await randomDelay(30000, 30000); // 30 seconds fixed delay for status check
  }
  logger.error(`[${config.name}] ❌ Swap did not complete after 10 attempts: ${txHash}`);
  return false;
};

const processSwap = async (privateKey, swapType, numTransactions, minEthAmount, maxEthAmount, minDelay, maxDelay, requireConfirmation, logger) => {
  try {
    logger.info(`[${config.name}] 🚀 Starting same-chain swap automation...`);
    
    const provider = new ethers.JsonRpcProvider(config.rpc, config.chainId);
    const wallet = new ethers.Wallet(privateKey, provider);
    const walletAddress = wallet.address;
    
    logger.info(`[${config.name}] 👛 Wallet: ${walletAddress}`);
    logger.info(`[${config.name}] 🌐 Network: ${config.name} (Chain ID: ${config.chainId})`);

    // Verify contract exists
    try {
      const contractCode = await provider.getCode(config.contract);
      if (contractCode === '0x') {
        logger.error(`[${config.name}] ❌ Contract at ${config.contract} has no code. Please verify the contract address.`);
        return {
          success: false,
          successCount: 0,
          failCount: numTransactions,
          totalSwaps: numTransactions
        };
      }
      logger.debug(`[${config.name}] ✅ Contract verified: ${contractCode.length} bytes`);
    } catch (contractError) {
      logger.error(`[${config.name}] ❌ Failed to verify contract: ${contractError.message}`);
      return {
        success: false,
        successCount: 0,
        failCount: numTransactions,
        totalSwaps: numTransactions
      };
    }

    // Determine STT amounts
    const ethAmounts = ['1', '2'].includes(swapType)
      ? Array(numTransactions).fill(minEthAmount)
      : Array(numTransactions).fill(0).map(() => (minEthAmount + Math.random() * (maxEthAmount - minEthAmount)).toFixed(18));

    // Calculate total required STT
    const gasEstimatePerTx = ethers.parseEther('0.00009794');
    let totalRequiredEth = BigInt(0);
    for (const ethAmount of ethAmounts) {
      const requiredEth = ethers.parseEther(ethAmount);
      const totalPerTx = requiredEth + gasEstimatePerTx;
      totalRequiredEth += totalPerTx;
    }

    const balance = await provider.getBalance(walletAddress);
    if (balance < totalRequiredEth) {
      logger.error(`[${config.name}] ❌ Insufficient STT. Required: ${ethers.formatEther(totalRequiredEth)} STT, Available: ${ethers.formatEther(balance)} STT`);
      return {
        success: false,
        successCount: 0,
        failCount: numTransactions,
        totalSwaps: numTransactions
      };
    }

    // Configuration summary
    logger.info(`[${config.name}] 📋 Configuration Summary:`);
    
    logger.info(`[${config.name}] 🔄 Swap type: ${swapType === '1' ? 'STT to EUCLID' : swapType === '2' ? 'STT to ANDR' : 'STT to Random Token'}`);
    logger.info(`[${config.name}] 📊 Transactions: ${numTransactions}`);
    logger.info(`[${config.name}] 💰 STT per transaction: ${['1', '2'].includes(swapType) ? minEthAmount : `${minEthAmount}–${maxEthAmount}`} STT${['1', '2'].includes(swapType) ? '' : ' (random)'}`);
    logger.info(`[${config.name}] ⛽ Total STT (incl. gas): ${ethers.formatEther(totalRequiredEth)} STT`);
    logger.info(`[${config.name}] ⏱️  Delay range: ${minDelay}–${maxDelay} seconds`);

    if (requireConfirmation) {
      const confirm = await (await import('readline/promises')).createInterface({ input: process.stdin, output: process.stdout }).question(`Continue with these settings for wallet ${walletAddress}? (y/n): `);
      if (confirm.toLowerCase() !== 'y') {
        logger.error(`[${config.name}] ❌ Cancelled for wallet ${walletAddress}.`);
        return {
          success: false,
          successCount: 0,
          failCount: numTransactions,
          totalSwaps: numTransactions
        };
      }
    } else {
      logger.info(`[${config.name}] ✅ Auto-continuing for wallet ${walletAddress}`);
    }

  // Fetch and validate tokens
  const tokens = await fetchAvailableTokens();
  if (tokens.length === 0) {
    logger.error(`[${config.name}] ❌ No tokens available.`);
    return {
      success: false,
      successCount: 0,
      failCount: numTransactions,
      totalSwaps: numTransactions
    };
  }
  logger.info(`[${config.name}] 🪙 Available tokens: ${tokens.join(', ')}`);

  const validTokens = [];
  const tokenChainUids = {
    stt: 'somnia',
    euclid: 'somnia', // Receive on same chain
    usdc: 'somnia',   // Receive on same chain
    usdt: 'somnia',   // Receive on same chain
  };

  // Log escrow balances for debugging but don't filter based on them
  // The API routes will handle escrow validation internally, and debug test shows this works
  for (const token of config.tokens) {
    const balance = await fetchEscrows(token);
    logger.info(`[${config.name}] 💰 ${token.toUpperCase()} escrow: ${balance}`);
  }

  // Don't filter by escrow since debug test shows routes work despite 0 escrow values
  const supportedTargetTokens = [];
  for (const token of config.tokens) {
    const amountInWei = ethers.parseEther(minEthAmount.toString());
    if (await validateTokenRoutes(token, [config.chainUid, 'vsl'], amountInWei)) {
      supportedTargetTokens.push(token);
    }
  }

  if (supportedTargetTokens.length === 0) {
    logger.error(`[${config.name}] ❌ No supported tokens with valid routes.`);
    return {
      success: false,
      successCount: 0,
      failCount: numTransactions,
      totalSwaps: numTransactions
    };
  }
  logger.info(`[${config.name}] ✅ Supported target tokens: ${supportedTargetTokens.join(', ')}`);

  let gasLimit = 2500000;
  
  // Get network gas info for better gas estimation
  let networkGasPrice;
  try {
    const feeData = await provider.getFeeData();
    networkGasPrice = feeData.gasPrice || feeData.maxFeePerGas;
    logger.debug(`[${config.name}] ⛽ Network gas price: ${ethers.formatUnits(networkGasPrice, 'gwei')} gwei`);
  } catch (gasInfoError) {
    logger.warn(`[${config.name}] ⚠️  Failed to get network gas info: ${gasInfoError.message}`);
  }
  
  let successCount = 0;
  let failCount = 0;


  
  for (let i = 0; i < numTransactions; i++) {
    const ethAmount = ethAmounts[i];
    const amountInWei = ethers.parseEther(ethAmount);
    
    // Prioritize USDC since debug test shows it works reliably
    let currentToken;
    if (supportedTargetTokens.includes('usdc')) {
      currentToken = 'usdc';
    } else {
      currentToken = supportedTargetTokens[Math.floor(Math.random() * supportedTargetTokens.length)];
    }
    
    let currentChainUid = tokenChainUids[currentToken] || 'vsl';
    logger.info(`[${config.name}] 🎯 Selected token (USDC prioritized): ${currentToken} (chain: ${currentChainUid})`);

    let attempt = 0;
    const maxAttempts = supportedTargetTokens.length;

    while (attempt < maxAttempts) {
      logger.info(`[${config.name}] 🔄 Transaction ${i + 1}/${numTransactions} (STT → ${currentToken.toUpperCase()}, ${ethAmount} STT):`);

      try {
        const routesPayload = {
          external: true,
          token_in: 'stt',
          token_out: currentToken,
          amount_in: amountInWei.toString(),
          chain_uids: [config.chainUid, 'vsl'],
          intermediate_tokens: supportedTargetTokens.filter(t => t !== currentToken && t !== 'stt'),
        };

        logger.info(`[${config.name}] 🗺️  Requesting route: STT → ${currentToken.toUpperCase()}`);
        // Add delay before API call to prevent rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const routesResponse = await retry(() =>
          axios.post(config.routesApi, routesPayload, {
            headers: { 'accept': 'application/json', 'content-type': 'application/json', 'Referer': 'https://testnet.euclidswap.io/' },
            timeout: 5000,
          })
        );

        let routes = routesResponse.data.paths;
        if (!routes || routes.length === 0) {
          logger.error(`[${config.name}] ❌ No routes found for STT → ${currentToken.toUpperCase()}`);
          break;
        }

        logger.info(`[${config.name}] ✅ Found ${routes.length} valid routes from API`);

        // Sort routes by route length (prefer shorter routes for better liquidity)
        routes.sort((a, b) => a.path[0].route.length - b.path[0].route.length);

        // Always select the first (shortest) route like debug test behavior
        const selectedRouteIndex = 0;
        // Extract all available fields from the selected route's path object
        const selectedRouteObj = routes[selectedRouteIndex].path[0];
        const selectedRoute = selectedRouteObj.route;
        const amountOut = selectedRouteObj.amount_out;
        const amountOutForHops = selectedRouteObj.amount_out_for_hops || [];
        const chainUidInRoute = selectedRouteObj.chain_uid || currentChainUid;
        const totalPriceImpact = selectedRouteObj.total_price_impact;
        logger.info(`[${config.name}] 🛤️  Selected route: ${selectedRoute.join(' → ')}, output: ${amountOut}`);
        logger.debug(`[${config.name}] Route API amount_in: ${selectedRouteObj.amount_in || 'not provided'}, our amount_in: ${amountInWei.toString()}`);
        logger.debug(`[${config.name}] Chain UID in route: ${chainUidInRoute}, target chain: ${currentChainUid}`);
        logger.debug(`[${config.name}] Full route object: ${JSON.stringify(selectedRouteObj)}`);

        // Use the raw amount_out from route API exactly like the working debug test
        // Skip simulation altogether and use route API values directly
        const routeAmountOut = amountOut; // Use raw amount_out from route API directly

        // Build swapPayload with structure matching successful working patterns
        // Use the correct destination chain UID from tokenChainUids mapping, not from route
        const destinationChainUid = currentChainUid; // This is already correctly set from tokenChainUids mapping
        const routeAmountIn = selectedRouteObj.amount_in || amountInWei.toString(); // Use route's amount_in if available
        const routeChainUid = selectedRouteObj.chain_uid || 'vsl'; // Chain UID for the swap_path (protocol internal)
        
        logger.debug(`[${config.name}] Chain UIDs - destination: ${destinationChainUid}, route internal: ${routeChainUid}, target token: ${currentToken}`);
        
        const swapPayload = {
          amount_in: routeAmountIn,
          asset_in: { token: 'stt', token_type: { __typename: 'NativeTokenType', native: { __typename: 'NativeToken', denom: 'stt' } } },
          slippage: '500',
          cross_chain_addresses: [{ user: { address: walletAddress, chain_uid: destinationChainUid }, limit: { less_than_or_equal: routeAmountOut } }], // Use raw amount_out from route
          partnerFee: { partner_fee_bps: 10, recipient: walletAddress },
          sender: { address: walletAddress, chain_uid: config.chainUid },
          swap_path: {
            path: [{
              route: selectedRoute,
              dex: 'euclid',
              amount_in: routeAmountIn,
              amount_out: routeAmountOut, // Use raw amount_out from route
              chain_uid: config.chainUid, // Use sender's chain_uid (somnia) for swap_path like debug test
              ...(selectedRouteObj.amount_out_for_hops ? { amount_out_for_hops: selectedRouteObj.amount_out_for_hops } : {})
            }],
            ...(selectedRouteObj.total_price_impact ? { total_price_impact: selectedRouteObj.total_price_impact } : {})
          },
          timeout: '60',
        };

        logger.debug(`[${config.name}] Swap payload: ${JSON.stringify(swapPayload)}`);

        // Add delay before swap API call to prevent rate limiting  
        await new Promise(resolve => setTimeout(resolve, 1500));

        const swapResponse = await retry(() =>
          axios.post(config.swapApi, swapPayload, {
            headers: { 'accept': 'application/json', 'content-type': 'application/json', 'Referer': 'https://testnet.euclidswap.io/' },
            timeout: 8000,
          })
        );

        let txData = swapResponse.data.msgs?.[0]?.data;
        if (!txData) {
          logger.error(`[${config.name}] ❌ Calldata missing for ${selectedRoute.join(' → ')}`);
          break;
        }

        // Use simple transaction object for simulation like debug test
        const simulationTx = {
          to: config.contract,
          value: selectedRouteObj.amount_in || amountInWei.toString(),
          data: txData
        };

        logger.debug(`[${config.name}] Simulation tx object: to=${simulationTx.to}, value=${simulationTx.value.toString()}, dataLength=${txData.length}`);

        try {
          // Use simple transaction object for simulation (matching debug test)
          logger.debug(`[${config.name}] Pre-transaction simulation: to=${simulationTx.to}, value=${simulationTx.value.toString()}, data=${simulationTx.data.slice(0, 100)}...`);
          await provider.call(simulationTx);
          logger.debug(`[${config.name}] ✅ Simulation passed successfully`);
        } catch (simulationError) {
          const errorMsg = simulationError.reason || simulationError.message || 'Unknown simulation error';
          logger.error(`[${config.name}] ❌ Simulation failed: ${errorMsg}`);
          
          // Check if it's the specific FactoryV1 error
          if (errorMsg.includes('FactoryV1') || errorMsg.includes('Delegate Call Reverted Silently')) {
            logger.warn(`[${config.name}] ⚠️  FactoryV1 delegate call error detected. This may be due to:`);
            logger.warn(`[${config.name}] - Insufficient escrow balance for target token`);
            logger.warn(`[${config.name}] - Incorrect contract address or calldata`);
            logger.warn(`[${config.name}] - Route not properly funded`);
            
            // Try with a different token if available
            if (attempt < maxAttempts - 1) {
              logger.warn(`[${config.name}] 🔄 Attempting with different token...`);
              break; // Will retry with new token
            }
          }
          break;
        }

        // Build full transaction object for actual sending after simulation passes
        const tx = {
          to: config.contract,
          value: BigInt(selectedRouteObj.amount_in || amountInWei.toString()),
          data: txData,
        };

        // Get gas estimate using simple transaction structure first
        let finalGasLimit = gasLimit;
        try {
          // Use simple transaction structure for gas estimation (same as simulation)
          const gasEstimate = await provider.estimateGas(simulationTx);
          finalGasLimit = (gasEstimate * 120n) / 100n;
          logger.debug(`[${config.name}] ⛽ Gas estimated: ${gasEstimate}, using: ${finalGasLimit}`);
        } catch (gasError) {
          logger.warn(`[${config.name}] ⚠️  Gas estimation failed: ${gasError.message}. Using default: ${gasLimit}`);
          finalGasLimit = gasLimit;
        }

        // Set gas limit
        tx.gasLimit = finalGasLimit;

        // Add nonce
        tx.nonce = await provider.getTransactionCount(walletAddress, 'pending');

        // Use simpler gas pricing approach for Somnia (similar to Python code pattern)
        try {
          const feeData = await provider.getFeeData();
          if (feeData.gasPrice) {
            // Use legacy gas pricing if available (more reliable for Somnia)
            tx.gasPrice = feeData.gasPrice;
            logger.debug(`[${config.name}] ⛽ Using legacy gas price: ${ethers.formatUnits(feeData.gasPrice, 'gwei')} gwei`);
          } else {
            // Fallback to EIP-1559 with conservative values
            const priorityFee = ethers.parseUnits('1', 'gwei'); // Lower priority fee
            const maxFee = ethers.parseUnits('3', 'gwei'); // Lower max fee
            tx.maxPriorityFeePerGas = priorityFee;
            tx.maxFeePerGas = maxFee;
            logger.debug(`[${config.name}] ⛽ Using EIP-1559 fees: priority=${ethers.formatUnits(priorityFee, 'gwei')}gwei, max=${ethers.formatUnits(maxFee, 'gwei')}gwei`);
          }
        } catch (feeError) {
          logger.warn(`[${config.name}] ⚠️  Failed to fetch fee data: ${feeError.message}. Using fallback gas price.`);
          tx.gasPrice = ethers.parseUnits('3', 'gwei'); // Conservative fallback
        }

        logger.debug(`[${config.name}] Final tx object: to=${tx.to}, value=${tx.value.toString()}, gasLimit=${tx.gasLimit}, nonce=${tx.nonce}`);
        
        // Add additional validation before sending transaction
        if (tx.gasLimit > 25000000n) {
          logger.warn(`[${config.name}] ⚠️  Gas limit seems too high: ${tx.gasLimit}. Using conservative limit.`);
          tx.gasLimit = 3000000n; // Conservative gas limit for Somnia
        }

        const txResponse = await wallet.sendTransaction(tx);
        logger.info(`[${config.name}] 🚀 Transaction sent! Hash: ${txResponse.hash}`);

        logger.info(`[${config.name}] ⏳ Waiting for confirmation...`);
        const receipt = await txResponse.wait();

        if (receipt.status === 1) {
          successCount++;
          logger.success(`[${config.name}] ✅ Transaction successful! Gas used: ${receipt.gasUsed}`);
          await retry(() =>
            axios.post(config.trackApi, {
              chain_uid: config.chainUid,
              tx_hash: txResponse.hash,
              wallet_address: walletAddress,
              referral_code: 'EUCLIDEAN301040',
              type: 'swap',
            }, {
              headers: {
                'accept': 'application/json',
                'content-type': 'application/json',
                'Referer': 'https://testnet.euclidswap.io/'
              }
            })
          );
          logger.success(`[${config.name}] 📊 Transaction tracked. View: ${config.explorer}${txResponse.hash}`);

          // Build meta object for status tracking using correct chain UIDs
          const meta = {
            asset_in_type: 'native',
            releases: [
              {
                dex: 'euclid',
                release_address: [
                  {
                    chain_uid: destinationChainUid, // Use the same chain_uid as in cross_chain_addresses
                    address: walletAddress,
                    amount: routeAmountOut // Use the correct variable name
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
                  chain_uid: config.chainUid, // Use sender's chain_uid (somnia) to match swap_path
                  amount_in: amountInWei.toString(),
                  amount_out: routeAmountOut // Use the correct variable name
                }
              ]
            }
          };
          await checkSwapStatus(txResponse.hash, walletAddress, provider, meta);
          break;
        } else {
          failCount++;
          logger.error(`[${config.name}] ❌ Transaction failed`);
          break;
        }
      } catch (error) {
        failCount++;
        logger.error(`[${config.name}] ❌ Error: ${error.message}`);
        
        // Handle rate limiting specifically
        if (error.response?.status === 429) {
          const retryAfter = error.response.headers['retry-after'] || 10;
          const delayMs = parseInt(retryAfter) * 1000;
          logger.warn(`[${config.name}] ⚠️  Rate limited (429). Waiting ${delayMs / 1000}s before retry...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
          // Don't increment attempt for 429 errors, just retry same token
          attempt--; // Decrement to retry with same attempt count
        }
      }

      attempt++;
      if (attempt < maxAttempts) {
        currentToken = supportedTargetTokens[Math.floor(Math.random() * supportedTargetTokens.length)];
        currentChainUid = tokenChainUids[currentToken] || 'vsl';
        logger.warn(`[${config.name}] 🔄 Retrying with fallback token: ${currentToken.toUpperCase()}`);
      }
    }

    if (i < numTransactions - 1) {
      const delay = (minDelay + Math.random() * (maxDelay - minDelay)) * 1000;
      logger.info(`[${config.name}] ⏳ Waiting ${Math.round(delay / 1000)} seconds before next transaction...`);
      await randomDelay(minDelay * 1000, maxDelay * 1000);
    }
  }

  logger.success(`[${config.name}] 🎉 All transactions completed for wallet ${walletAddress}!`);
  
  return {
    success: successCount > 0,
    successCount,
    failCount,
    totalSwaps: numTransactions
  };
} catch (error) {
  logger.error(`[${config.name}] ❌ Fatal error: ${error.message}`);
  return {
    success: false,
    successCount: 0,
    failCount: numTransactions,
    totalSwaps: numTransactions
  };
}
};

async function main() {
  // Update private keys path in all chain modules
  const privateKeys = (await import('fs/promises'))
    .readFile('data/private_keys.txt', 'utf8')
    .then(data => data
      .split('\n')
      .map(line => line.replace(/\r/g, '').trim())
      .filter(line => line && line.startsWith('0x'))
    );
  for (const key of await privateKeys) {
    const numSwaps = getRandomInRange(FLOW.somnia.NUMBER_OF_SWAPS[0], FLOW.somnia.NUMBER_OF_SWAPS[1]);
    const minAmount = FLOW.somnia.AMOUNT_TO_SWAP[0];
    const maxAmount = FLOW.somnia.AMOUNT_TO_SWAP[1];
    const minDelay = SETTINGS.PAUSE_BETWEEN_SWAPS[0];
    const maxDelay = SETTINGS.PAUSE_BETWEEN_SWAPS[1];
    await processSwap(key, 'random', numSwaps, minAmount, maxAmount, minDelay, maxDelay, false, logger);
  }
}


export default processSwap;
