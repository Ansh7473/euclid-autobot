
import { ethers } from 'ethers';
import axios from 'axios';
import { GraphQLClient } from 'graphql-request';
import { SETTINGS, randomDelay, SHOW_SWAP_PENDING_LOG } from '../config.js';

// Detect ethers v6
const isEthersV6 = typeof ethers.parseEther === 'function';

const config = {
  rpc: 'https://testnet-rpc.monad.xyz',
  chainId: 10143,
  name: 'Monad',
  contract: '0xF2401973d404b532E816Fa54f22980CE91dCdd53',
  explorer: 'https://explorer.node.monad.xyz/tx/',
  tokens: ['euclid', 'usdc', 'usdt', 'mon'],
  chainUid: 'monad'
};

// Update private keys path in all chain modules
const privateKeys = (await import('fs/promises'))
  .readFile('data/private_keys.txt', 'utf8')
  .then(data => data
    .split('\n')
    .map(line => line.replace(/\r/g, '').trim())
    .filter(line => line && line.startsWith('0x'))
  );

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
      'accept-language': 'en-US,en;q=0.5',
      'priority': 'u=1, i',
      'sec-ch-ua': '"Chromium";v="136", "Brave";v="136", "Not.A/Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'cross-site',
      'sec-gpc': '1',
      'Referer': 'https://testnet.euclidswap.io/',
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    }
  });
};

const axiosInstance = createAxiosInstance();

// GraphQL client for Monad
const graphqlClient = new GraphQLClient('https://testnet.api.euclidprotocol.com/graphql', {
  headers: {
    accept: 'application/json',
    'content-type': 'application/json',
  },
  timeout: 10000,
});

const processSwap = async (privateKey, swapType, numTransactions, minEthAmount, maxEthAmount, minDelay, maxDelay, requireConfirmation, logger) => {
  try {
    logger.info(`[✓] [${config.name}] 🚀 Starting same-chain swap automation...`);
    
    const provider = new ethers.JsonRpcProvider(config.rpc, config.chainId);
    const wallet = isEthersV6 ? new ethers.Wallet(privateKey, provider) : new ethers.Wallet(privateKey, provider);
    const walletAddress = wallet.address;
    
    logger.info(`[${config.name}] 👛 Wallet: ${walletAddress}`);
    logger.info(`[${config.name}] 🌐 Network: ${config.name} (Chain ID: ${config.chainId})`);

    // Verify contract exists
    try {
      const contractCode = await provider.getCode(config.contract);
      if (contractCode === '0x') {
        logger.error(`[${config.name}] ❌ Contract not found at address: ${config.contract}`);
        return {
          success: false,
          successCount: 0,
          failCount: numTransactions,
          totalSwaps: numTransactions
        };
      }
      logger.debug(`[DEBUG] Contract verified at ${config.contract} (code length: ${contractCode.length})`);
    } catch (contractError) {
      logger.error(`[${config.name}] ❌ Failed to verify contract: ${contractError.message}`);
      return {
        success: false,
        successCount: 0,
        failCount: numTransactions,
        totalSwaps: numTransactions
      };
    }

    // Determine MON amounts (MON is the native token on Monad)
    const monAmounts = ['1', '2'].includes(swapType)
      ? Array(numTransactions).fill(minEthAmount)
      : Array(numTransactions).fill(0).map(() => (minEthAmount + Math.random() * (maxEthAmount - minEthAmount)).toFixed(18));

    // Calculate total required MON (native token)
    const gasEstimatePerTx = isEthersV6 ? ethers.parseEther('0.00009794') : ethers.utils.parseUnits('0.00009794', 'ether');
    let totalRequiredMon = BigInt(0);
    for (const monAmount of monAmounts) {
      const requiredMon = isEthersV6 ? ethers.parseEther(monAmount) : ethers.utils.parseEther(monAmount);
      const totalPerTx = isEthersV6 ? requiredMon + gasEstimatePerTx : requiredMon.add(gasEstimatePerTx);
      totalRequiredMon = isEthersV6 ? totalRequiredMon + totalPerTx : totalRequiredMon.add(totalPerTx);
    }

    const balance = await provider.getBalance(walletAddress);
    if (isEthersV6 ? balance < totalRequiredMon : balance.lt(totalRequiredMon)) {
      logger.error(`[${config.name}] ❌ Insufficient MON. Required: ${isEthersV6 ? ethers.formatEther(totalRequiredMon) : ethers.utils.formatEther(totalRequiredMon)} MON, Available: ${isEthersV6 ? ethers.formatEther(balance) : ethers.utils.formatEther(balance)} MON`);
      return {
        success: false,
        successCount: 0,
        failCount: numTransactions,
        totalSwaps: numTransactions
      };
    }

    // Configuration summary
    logger.info(`[${config.name}] 📋 Configuration Summary:`);
    
    logger.info(`[${config.name}] 🔄 Swap type: ${swapType === '1' ? 'MON to EUCLID' : swapType === '2' ? 'MON to ANDR' : 'Random Swap'}`);
    logger.info(`[${config.name}] 📊 Transactions: ${numTransactions}`);
    logger.info(`[${config.name}] 💰 MON per transaction: ${['1', '2'].includes(swapType) ? minEthAmount : `${minEthAmount}–${maxEthAmount}`} MON${['1', '2'].includes(swapType) ? '' : ' (random)'}`);
    logger.info(`[${config.name}] ⛽ Total MON (incl. gas): ${isEthersV6 ? ethers.formatEther(totalRequiredMon) : ethers.utils.formatEther(totalRequiredMon)} MON`);
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
  const tokens = await fetchAvailableTokens(config.chainUid, logger);
  if (tokens.length === 0) {
    logger.error(`No tokens available on ${config.name}.`);
    return {
    success: false,
    successCount: 0,
    failCount: numTransactions,
    totalSwaps: numTransactions
  };
  }

  const validTokens = [];
  const tokenChainUids = {
    mon: 'monad',
    euclid: 'optimism',
    usdc: 'base',
    usdt: 'base',
  };

  // Fetch all escrow balances in parallel for better performance
  const escrowPromises = ['euclid', 'mon', 'usdc', 'usdt'].map(async (token) => {
    const destChainUid = tokenChainUids[token] || config.chainUid;
    const balance = await fetchEscrows(token, destChainUid, logger);
    return { token, balance };
  });

  const escrowResults = await Promise.all(escrowPromises);
  
  for (const { token, balance } of escrowResults) {
    if (balance > 0 || (['1'].includes(swapType) && token === 'euclid') || (swapType === '2' && token === 'andr')) {
      validTokens.push(token);
    }
  }

  if (validTokens.length === 0) {
    logger.error(`No tokens with sufficient escrow balance on ${config.name}.`);
    return {
    success: false,
    successCount: 0,
    failCount: numTransactions,
    totalSwaps: numTransactions
  };
  }

  const possibleTargetTokens = ['euclid', 'mon', 'usdc', 'usdt'];
  // Remove duplicate tokenChainUids declaration here

  const supportedTargetTokens = [];
  for (const token of possibleTargetTokens) {
    const amountInWei = isEthersV6 ? ethers.parseEther(minEthAmount.toString()) : ethers.utils.parseEther(minEthAmount.toString());
    if (await validateTokenRoutes(token, [config.chainUid, 'vsl'], amountInWei, logger)) {
      supportedTargetTokens.push(token);
    }
  }

  if (supportedTargetTokens.length === 0) {
    logger.error(`No supported tokens with valid routes on ${config.name}.`);
    return {
    success: false,
    successCount: 0,
    failCount: numTransactions,
    totalSwaps: numTransactions
  };
  }

  // Dynamic gas pricing configuration
  const gasConfig = {
    minGasLimit: 1000000,    // 1M gas minimum
    maxGasLimit: 5000000,    // 5M gas maximum
    defaultGasLimit: 2000000, // 2M gas default
    gasMultiplier: 1.2       // 20% buffer for gas estimation
  };
  
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < numTransactions; i++) {
    const monAmount = monAmounts[i];
    const amountInWei = isEthersV6 ? ethers.parseEther(monAmount) : ethers.utils.parseEther(monAmount);
    let currentToken = supportedTargetTokens[Math.floor(Math.random() * supportedTargetTokens.length)];
    let currentChainUid = tokenChainUids[currentToken] || 'vsl';

    let attempt = 0;
    const maxAttempts = supportedTargetTokens.length;

    while (attempt < maxAttempts) {
      logger.loading(`Transaction ${i + 1}/${numTransactions} (MON to ${currentToken}, ${monAmount} MON) for wallet ${walletAddress}:`);
      try {
        const routesPayload = {
          external: true,
          token_in: 'mon',
          token_out: currentToken,
          amount_in: amountInWei.toString(),
          chain_uids: [config.chainUid, 'vsl'],
          intermediate_tokens: supportedTargetTokens.filter(t => t !== currentToken && t !== 'mon')
        };
        const routesResponse = await retry(() =>
          axios.post('https://testnet.api.euclidprotocol.com/api/v1/routes?limit=10', routesPayload, {
            headers: { 'accept': 'application/json', 'content-type': 'application/json', 'Referer': 'https://testnet.euclidswap.io/' },
            timeout: 5000
          })
        );
        const routes = routesResponse.data.paths;
        if (!routes || routes.length === 0) {
          logger.warn(`No routes found for MON -> ${currentToken}. Trying next token...`);
          break;
        }
        const selectedRouteIndex = Math.floor(Math.random() * routes.length);
        const selectedRoute = routes[selectedRouteIndex].path[0].route;
        const amountOut = routes[selectedRouteIndex].path[0].amount_out;
        
        const slippage = 0.1; // Increase slippage to 10%
        const minAmountOut = Math.floor(parseInt(amountOut) * (1 - slippage)).toString();

        const selectedRouteObj = routes[selectedRouteIndex].path[0];
        const amountOutForHops = selectedRouteObj.amount_out_for_hops || [];
        const chainUidInRoute = selectedRouteObj.chain_uid || 'vsl';
        const totalPriceImpact = selectedRouteObj.total_price_impact;

        const swapPayload = {
          amount_in: amountInWei.toString(),
          asset_in: { token: 'mon', token_type: { __typename: 'NativeTokenType', native: { __typename: 'NativeToken', denom: 'mon' } } },
          slippage: '1000', // 10% slippage in basis points
          cross_chain_addresses: [{ user: { address: walletAddress, chain_uid: currentChainUid }, limit: { less_than_or_equal: minAmountOut } }],
          partnerFee: { partner_fee_bps: 10, recipient: walletAddress },
          sender: { address: walletAddress, chain_uid: config.chainUid },
          swap_path: {
            path: [{
              route: selectedRoute,
              dex: 'euclid',
              amount_in: amountInWei.toString(),
              amount_out: minAmountOut,
              chain_uid: chainUidInRoute,
              amount_out_for_hops: amountOutForHops
            }],
            ...(totalPriceImpact ? { total_price_impact: totalPriceImpact } : {})
          },
          timeout: '120' // Increase timeout to 2 minutes
        };

        logger.debug(`[swapPayload] ${JSON.stringify(swapPayload)}`);
        const swapResponse = await retry(() =>
          axios.post('https://testnet.api.euclidprotocol.com/api/v1/execute/astro/swap', swapPayload, {
            headers: { 'accept': 'application/json', 'content-type': 'application/json', 'Referer': 'https://testnet.euclidswap.io/' },
            timeout: 5000
          })
        );
        let txData = swapResponse.data.msgs?.[0]?.data;
        logger.debug(`[txData] ${txData}`);
        if (!txData) {
          logger.error(`Calldata missing for ${selectedRoute.join(' -> ')}.`);
          break;
        }
        
        // Validate transaction data
        if (!txData.startsWith('0x')) {
          logger.error(`Invalid transaction data format: ${txData}`);
          break;
        }
        
        if (txData.length < 10) {
          logger.error(`Transaction data too short: ${txData}`);
          break;
        }

        const tx = {
          to: config.contract,
          value: amountInWei,
          data: txData,
          gasLimit: gasConfig.defaultGasLimit, // Start with default, will be updated by gas estimation
          nonce: await provider.getTransactionCount(walletAddress, 'pending'),
        };

        logger.debug(`[DEBUG] Transaction details:`);
        logger.debug(`[DEBUG] - To: ${tx.to}`);
        logger.debug(`[DEBUG] - Value: ${tx.value.toString()}`);
        logger.debug(`[DEBUG] - Data length: ${tx.data.length}`);
        logger.debug(`[DEBUG] - Gas limit: ${tx.gasLimit}`);
        logger.debug(`[DEBUG] - Nonce: ${tx.nonce}`);

        try {
          const latestBlock = await provider.getBlock('latest');
          const baseFee = latestBlock.baseFeePerGas || (latestBlock.baseFeePerGas === 0 ? 0 : null);
          const priorityFee = isEthersV6 ? ethers.parseUnits('1', 'gwei') : ethers.utils.parseUnits('1', 'gwei');
          if (baseFee !== null && baseFee !== undefined) {
            tx.maxPriorityFeePerGas = priorityFee;
            tx.maxFeePerGas = isEthersV6 ? baseFee + priorityFee : baseFee.add(priorityFee);
          } else {
            tx.maxPriorityFeePerGas = priorityFee;
            tx.maxFeePerGas = isEthersV6 ? ethers.parseUnits('2', 'gwei') : ethers.utils.parseUnits('2', 'gwei');
          }
        } catch (feeError) {
          logger.warn(`Failed to fetch base fee: ${feeError.message}. Using default gas fees.`);
          const fallback = isEthersV6 ? ethers.parseUnits('2', 'gwei') : ethers.utils.parseUnits('2', 'gwei');
          tx.maxPriorityFeePerGas = fallback;
          tx.maxFeePerGas = fallback;
        }

        try {
          const gasEstimate = await provider.estimateGas(tx);
          let finalGasLimit = isEthersV6 ? (gasEstimate * BigInt(Math.floor(gasConfig.gasMultiplier * 100))) / 100n : gasEstimate.mul(Math.floor(gasConfig.gasMultiplier * 100)).div(100);
          
          // Ensure gas limit is within acceptable bounds
          if (isEthersV6) {
            if (finalGasLimit < BigInt(gasConfig.minGasLimit)) finalGasLimit = BigInt(gasConfig.minGasLimit);
            if (finalGasLimit > BigInt(gasConfig.maxGasLimit)) finalGasLimit = BigInt(gasConfig.maxGasLimit);
          } else {
            if (finalGasLimit.lt(gasConfig.minGasLimit)) finalGasLimit = ethers.BigNumber.from(gasConfig.minGasLimit);
            if (finalGasLimit.gt(gasConfig.maxGasLimit)) finalGasLimit = ethers.BigNumber.from(gasConfig.maxGasLimit);
          }
          
          tx.gasLimit = finalGasLimit;
          logger.debug(`⛽ Gas estimated: ${gasEstimate}, using: ${finalGasLimit} (bounded)`);
        } catch (gasError) {
          logger.warn(`⚠ Gas estimation failed. Using default: ${gasConfig.defaultGasLimit}`);
          tx.gasLimit = gasConfig.defaultGasLimit;
        }

        try {
          logger.debug(`[DEBUG] Simulating transaction: to=${tx.to}, value=${tx.value}, gasLimit=${tx.gasLimit}`);
          await provider.call(tx);
          logger.debug(`[DEBUG] Simulation successful`);
        } catch (simulationError) {
          logger.error(`✗ Simulation failed: ${simulationError.reason || simulationError.message}`);
          logger.debug(`[DEBUG] Full simulation error: ${JSON.stringify(simulationError)}`);
          
          // Try with higher gas limit if simulation fails
          if (simulationError.message?.includes('out of gas')) {
            logger.warn(`⚠ Retrying with higher gas limit...`);
            tx.gasLimit = isEthersV6 ? BigInt(gasConfig.maxGasLimit) : ethers.BigNumber.from(gasConfig.maxGasLimit);
            try {
              await provider.call(tx);
              logger.debug(`[DEBUG] Simulation successful with higher gas`);
            } catch (retryError) {
              logger.error(`✗ Simulation still failed with higher gas: ${retryError.reason || retryError.message}`);
              break;
            }
          } else {
            break;
          }
        }

        const txResponse = await wallet.sendTransaction(tx);
        logger.info(`[${config.name}] 📤 Transaction sent! Hash: ${txResponse.hash}`);

        logger.loading(`[${config.name}] ⏳ Waiting for confirmation...`);
        const receipt = await txResponse.wait();

        if (receipt.status === 1) {
          successCount++;
          logger.success(`✅ Swap ${i + 1} completed successfully!`);
          logger.success(`🎯 Route: MON -> ${currentToken}`);
          logger.success(`💰 Amount: ${monAmount} MON`);
          logger.success(`⛽ Gas used: ${receipt.gasUsed}`);
          logger.success(`🔗 TX: ${config.explorer}${txResponse.hash}`);
          await retry(() =>
            axios.post('https://testnet.euclidswap.io/api/intract-track', {
              chain_uid: config.chainUid,
              tx_hash: txResponse.hash,
              wallet_address: walletAddress,
              referral_code: 'EUCLIDEAN301040',
              type: 'swap'
            }, { headers: { 'accept': 'application/json', 'content-type': 'application/json', 'Referer': 'https://testnet.euclidswap.io/' } })
          );
          logger.success(`Transaction tracked. View: ${config.explorer}${txResponse.hash}`);
          // Add meta and checkSwapStatus for pending log
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
          await checkSwapStatus(txResponse.hash, config.chainUid, walletAddress, provider, logger, meta);
          break;
        } else {
          failCount++;
          logger.error(`❌ Swap ${i + 1} failed: Transaction failed`);
          logger.error(`🎯 Failed route: MON -> ${currentToken}`);
          break;
        }
      } catch (error) {
        failCount++;
        logger.error(`❌ Swap ${i + 1} failed: ${error.message}`);
        if (error.response?.status === 429) {
          logger.warn(`Rate limit encountered. Retrying after delay...`);
          await randomDelay(30000, 35000);
        }
      }

      attempt++;
      if (attempt < maxAttempts) {
        logger.loading(`Retrying swap for ${currentToken} (Attempt ${attempt + 1}/${maxAttempts})...`);
        await new Promise(res => setTimeout(res, 2000));
      }
    }
    if (i < numTransactions - 1) {
      await new Promise(res => setTimeout(res, (minDelay + Math.random() * (maxDelay - minDelay)) * 1000));
    }
  }
  
  // Final summary
  logger.info(`[${config.name}] 📊 Final Results:`);
  logger.info(`[${config.name}] ✅ Successful swaps: ${successCount}/${numTransactions}`);
  logger.info(`[${config.name}] ❌ Failed swaps: ${failCount}/${numTransactions}`);
  logger.info(`[${config.name}] 🏁 Wallet processing completed`);

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

// Helper: fetchAvailableTokens
const fetchAvailableTokens = async (chainUid = config.chainUid, logger = console) => {
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
  
  // Retry logic for API resilience
  const maxRetries = 3;
  const baseDelay = 2000;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const variables = {
        token_token_metadatas_limit: 1000,
        token_token_metadatas_verified: true,
        token_token_metadatas_chain_uids: [chainUid],
      };
      
      logger.debug(`[${config.name}] Fetching tokens (attempt ${attempt}/${maxRetries})...`);
      const response = await graphqlClient.request(query, variables);
      
      // Check for GraphQL errors in response
      if (response?.errors && response.errors.length > 0) {
        const errorMsg = response.errors[0].message;
        if (errorMsg.includes('NotPrimaryOrSecondary') || errorMsg.includes('not in primary or recovering state')) {
          logger.warn(`[${config.name}] ⚠️  Database state issue (attempt ${attempt}/${maxRetries}): ${errorMsg}`);
          if (attempt < maxRetries) {
            const delay = baseDelay * Math.pow(2, attempt - 1);
            logger.info(`[${config.name}] 🔄 Retrying in ${delay / 1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
        } else {
          throw new Error(errorMsg);
        }
      }
      
      const metadatas = response?.token?.token_metadatas;
      if (!Array.isArray(metadatas)) {
        // Fallback to default token list if API fails
        logger.warn(`[${config.name}] ⚠️  Token metadata missing, using fallback tokens`);
        return ['euclid', 'usdc', 'usdt']; // Known working tokens for Monad
      }
      
      const tokens = metadatas
        .filter(metadata => metadata.chain_uids.includes(chainUid))
        .map(metadata => metadata.tokenId)
        .filter(token => token !== 'mon');
        
      if (tokens.length === 0) {
        logger.warn(`[${config.name}] ⚠️  No tokens found, using fallback tokens`);
        return ['euclid', 'usdc', 'usdt'];
      }
      
      logger.info(`[${config.name}] ✅ Successfully fetched ${tokens.length} tokens`);
      return tokens;
      
    } catch (error) {
      logger.warn(`[${config.name}] ⚠️  Attempt ${attempt} failed: ${error.message}`);
      
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        logger.info(`[${config.name}] 🔄 Retrying in ${delay / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        logger.warn(`[${config.name}] ⚠️  All attempts failed, using fallback tokens`);
        return ['euclid', 'usdc', 'usdt']; // Fallback to known working tokens
      }
    }
  }
  
  // Final fallback
  return ['euclid', 'usdc', 'usdt'];
};

// Helper: fetchEscrows
const fetchEscrows = async (token, chainUid, logger) => {
  try {
    const response = await axios.post(
      'https://testnet.api.euclidprotocol.com/graphql',
      {
        query: `
          query Escrows($token: String!) {
            router {
              escrows(token: $token) {
                chain_uid
                balance
                chain_id
              }
            }
          }
        `,
        variables: { token },
      },
      {
        headers: { 'accept': 'application/json', 'content-type': 'application/json' },
        timeout: 5000,
      }
    );
    logger.debug(`[fetchEscrows] Response for ${token}: ${JSON.stringify(response.data)}`);
    const escrows = response.data?.data?.router?.escrows || [];
    const escrow = escrows.find(e => e.chain_uid === chainUid);
    if (!escrow) {
      logger.warn(`[fetchEscrows] No escrow found for ${token} on ${chainUid}`);
      return 0;
    }
    // Parse balance as BigInt if possible, fallback to parseInt
    let balance = escrow.balance;
    if (typeof balance === 'string') {
      try {
        balance = BigInt(balance);
      } catch {
        balance = parseInt(balance);
      }
    }
    logger.debug(`[fetchEscrows] Parsed balance for ${token} on ${chainUid}: ${balance}`);
    return balance;
  } catch (error) {
    logger.error(`Failed to fetch escrows for ${token}: ${error.message}`);
    return 0;
  }
};

// Helper: validateTokenRoutes
const validateTokenRoutes = async (token, chainUids, amountInWei, logger) => {
  try {
    const routesPayload = {
      external: true,
      token_in: 'mon',
      token_out: token,
      amount_in: amountInWei.toString(),
      chain_uids: chainUids,
      intermediate_tokens: ['euclid', 'mon', 'usdc', 'usdt'],
    };
    const response = await axios.post(
      'https://testnet.api.euclidprotocol.com/api/v1/routes?limit=10',
      routesPayload,
      {
        headers: { 'accept': 'application/json', 'content-type': 'application/json', 'Referer': 'https://testnet.euclidswap.io/' },
        timeout: 8000,
      }
    );
    return response.data.paths && response.data.paths.length > 0;
  } catch (error) {
    logger.debug(`Route validation failed for ${token}: ${error.message}`);
    return false;
  }
};

// Helper: checkSwapStatus (Monad swap pending log)
const checkSwapStatus = async (txHash, chainUid, walletAddress, provider, logger, meta, maxAttempts = 10, delay = 30000) => {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await axios.post(
        'https://testnet.api.euclidprotocol.com/api/v1/txn/track/swap',
        {
          chain: chainUid,
          tx_hash: txHash,
          meta: meta ? JSON.stringify(meta) : ''
        },
        {
          headers: {
            'accept': 'application/json',
            'content-type': 'application/json',
            'Referer': 'https://testnet.euclidswap.io/'
          },
          timeout: 5000
        }
      );
      if (response.data?.response?.is_completed) {
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
    await randomDelay(delay, delay + 5000);
  }
  logger.error(`[Monad] Swap did not complete after ${maxAttempts} attempts: ${txHash}`);
  return false;
};

export default processSwap;