import { ethers } from 'ethers';
import axios from 'axios';
import { SETTINGS, randomDelay, SHOW_SWAP_PENDING_LOG } from '../config.js';

// Detect ethers v6
const isEthersV6 = typeof ethers.parseEther === 'function';


const config = {
  rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
  chainId: 11155111,
  name: 'Ethereum Sepolia',
  contract: '0x97c4604d1AAF3738dF8Fbb5726d6b748F8a866B1',
  explorer: 'https://sepolia.etherscan.io/tx/',
  tokens: ['euclid', 'usdc', 'usdt'],
  chainUid: 'sepolia'
 
};

// Update private keys path in all chain modules
const privateKeys = (await import('fs/promises'))
  .readFile('data/private_keys.txt', 'utf8')
  .then(data => data
    .split('\n')
    .map(line => line.replace(/\r/g, '').trim())
    .filter(line => line && line.startsWith('0x'))
  );

const processSwap = async (privateKey, swapType, numTransactions, minEthAmount, maxEthAmount, minDelay, maxDelay, requireConfirmation, logger) => {
  const provider = new ethers.JsonRpcProvider(config.rpc, config.chainId);
  const wallet = isEthersV6 ? new ethers.Wallet(privateKey, provider) : new ethers.Wallet(privateKey, provider);
  const walletAddress = wallet.address;
  logger.info(`[✓] [${config.name}] 🚀 Starting same-chain swap automation...`);
    logger.info(`[✓] [${config.name}] 👛 Wallet: ${walletAddress}`);
    logger.info(`[✓] [${config.name}] 🌐 Network: ${config.name} (Chain ID: ${config.chainId})`);

  const ethAmounts = Array(numTransactions).fill(0).map(() => (minEthAmount + Math.random() * (maxEthAmount - minEthAmount)).toFixed(18));

  const gasEstimatePerTx = isEthersV6 ? ethers.parseEther('0.00009794') : ethers.utils.parseUnits('0.00009794', 'ether');
  let totalRequiredEth = BigInt(0);
  for (const ethAmount of ethAmounts) {
    const requiredEth = isEthersV6 ? ethers.parseEther(ethAmount) : ethers.utils.parseEther(ethAmount);
    const totalPerTx = isEthersV6 ? requiredEth + gasEstimatePerTx : requiredEth.add(gasEstimatePerTx);
    totalRequiredEth = isEthersV6 ? totalRequiredEth + totalPerTx : totalRequiredEth.add(totalPerTx);
  }

  const balance = await provider.getBalance(walletAddress);
  if (isEthersV6 ? balance < totalRequiredEth : balance.lt(totalRequiredEth)) {
    logger.error(`[✓] [${config.name}] ❌ Insufficient ETH. Required: ${isEthersV6 ? ethers.formatEther(totalRequiredEth) : ethers.utils.formatEther(totalRequiredEth)} ETH, Available: ${isEthersV6 ? ethers.formatEther(balance) : ethers.utils.formatEther(balance)} ETH`);
    return {
    success: false,
    successCount: 0,
    failCount: numTransactions,
    totalSwaps: numTransactions
  };
  }

  logger.info(`[✓] [${config.name}] 📋 Configuration Summary:`);
    logger.info(`[✓] [${config.name}] 🔄 Swap type: ETH to Random Token`);
  logger.info(`[✓] [${config.name}] 📊 Transactions: ${numTransactions}`);
  logger.info(`[✓] [${config.name}] 💰 ETH per transaction: ${minEthAmount}–${maxEthAmount} ETH (random)`);
  logger.info(`[✓] [${config.name}] ⛽ Total ETH (incl. gas): ${isEthersV6 ? ethers.formatEther(totalRequiredEth) : ethers.utils.formatEther(totalRequiredEth)} ETH`);
  logger.info(`[✓] [${config.name}] ⏱️  Delay range: ${minDelay}–${maxDelay} seconds`);

  if (requireConfirmation) {
    const confirm = await (await import('readline/promises')).createInterface({ input: process.stdin, output: process.stdout }).question(`Continue with these settings for wallet ${walletAddress}? (y/n): `);
    if (confirm.toLowerCase() !== 'y') {
      logger.error(`[✓] [${config.name}] ❌ Cancelled for wallet ${walletAddress}.`);
      return {
    success: false,
    successCount: 0,
    failCount: numTransactions,
    totalSwaps: numTransactions
  };
    }
  } else {
    logger.info(`[✓] [${config.name}] ✅ Auto-continuing for wallet ${walletAddress}`);
  }

  // Fetch and validate tokens
  const tokens = await fetchAvailableTokens(config.chainUid, logger);
  if (!tokens || tokens.length === 0) {
    logger.error(`[✓] [${config.name}] ❌ No tokens available on ${config.name}.`);
    return {
    success: false,
    successCount: 0,
    failCount: numTransactions,
    totalSwaps: numTransactions
  };
  }

  // Display escrow balances for each token
  logger.info(`[✓] [${config.name}] 💰 Token Escrow Balances:`);
  const validTokens = [];
  for (const token of ['euclid', 'usdc', 'usdt']) {
    const balance = await fetchEscrows(token, config.chainUid, logger);
    logger.info(`[✓] [${config.name}] 🔸 ${token.toUpperCase()}: ${balance} (escrow)`);
    if (balance > 0) {
      validTokens.push(token);
    }
  }

  if (validTokens.length === 0) {
    logger.error(`[✓] [${config.name}] ❌ No tokens with sufficient escrow balance on ${config.name}.`);
    return {
    success: false,
    successCount: 0,
    failCount: numTransactions,
    totalSwaps: numTransactions
  };
  }

  const possibleTargetTokens = ['euclid', 'usdc', 'usdt'];
  const tokenChainUids = {
    euclid: 'optimism',
    usdc: 'sepolia',
    usdt: 'sepolia'
  };

  // Discover available route targets
  logger.info(`[✓] [${config.name}] 🔍 Discovering available routes...`);
  const supportedTargetTokens = [];
  for (const token of possibleTargetTokens) {
    const amountInWei = isEthersV6 ? ethers.parseEther(minEthAmount.toString()) : ethers.utils.parseEther(minEthAmount.toString());
    if (await validateTokenRoutes(token, [config.chainUid], amountInWei, logger)) {
      supportedTargetTokens.push(token);
      logger.info(`[✓] [${config.name}] ✅ Route available: ETH → ${token.toUpperCase()}`);
    } else {
      logger.warn(`[✓] [${config.name}] ⚠️  Route unavailable: ETH → ${token.toUpperCase()}`);
    }
  }

  if (supportedTargetTokens.length === 0) {
    logger.error(`[✓] [${config.name}] ❌ No supported tokens with valid routes on ${config.name}.`);
    return {
    success: false,
    successCount: 0,
    failCount: numTransactions,
    totalSwaps: numTransactions
  };
  }

  let gasLimit = 2500000;
  let successCount = 0;
  let failCount = 0;


  for (let i = 0; i < numTransactions; i++) {
    const ethAmount = ethAmounts[i];
    const amountInWei = isEthersV6 ? ethers.parseEther(ethAmount) : ethers.utils.parseEther(ethAmount);
    let currentToken = supportedTargetTokens[Math.floor(Math.random() * supportedTargetTokens.length)];
    let currentChainUid = tokenChainUids[currentToken] || 'sepolia';

    let attempt = 0;
    const maxAttempts = supportedTargetTokens.length;

    while (attempt < maxAttempts) {
      logger.info(`[✓] [${config.name}] 🎯 Token pair: eth -> ${currentToken}`);
      logger.loading(`[✓] [${config.name}] 🔄 Processing transaction ${i + 1}/${numTransactions} (ETH to ${currentToken}, ${ethAmount} ETH)...`);
      try {
        const routesPayload = {
          external: true,
          token_in: 'eth',
          token_out: currentToken,
          amount_in: amountInWei.toString(),
          chain_uids: [config.chainUid],
          intermediate_tokens: supportedTargetTokens.filter(t => t !== currentToken && t !== 'eth')
        };
        const routesResponse = await retry(() =>
          axios.post('https://testnet.api.euclidprotocol.com/api/v1/routes?limit=10', routesPayload, {
            headers: { 'accept': 'application/json', 'content-type': 'application/json', 'Referer': 'https://testnet.euclidswap.io/' },
            timeout: 8000
          })
        );
        const routes = routesResponse.data.paths;
        if (!routes || routes.length === 0) {
          logger.error(`[✓] [${config.name}] ❌ No routes found for ETH to ${currentToken} on ${config.name}.`);
          break;
        }
        const selectedRouteIndex = Math.floor(Math.random() * routes.length);
        const selectedRoute = routes[selectedRouteIndex].path[0].route;
        const amountOut = routes[selectedRouteIndex].path[0].amount_out;
        const slippage = 0.05;
        const minAmountOut = Math.floor(parseInt(amountOut) * (1 - slippage)).toString();
        // Extract extra fields from the selected route if available
        const selectedRouteObj = routes[selectedRouteIndex].path[0];
        const amountOutForHops = selectedRouteObj.amount_out_for_hops || [];
        const chainUidInRoute = selectedRouteObj.chain_uid || 'sepolia';
        const totalPriceImpact = selectedRouteObj.total_price_impact;
        const swapPayload = {
          amount_in: amountInWei.toString(),
          asset_in: { token: 'eth', token_type: { __typename: 'NativeTokenType', native: { __typename: 'NativeToken', denom: 'eth' } } },
          slippage: '500',
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
          timeout: '60'
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
          logger.error(`[✓] [${config.name}] ❌ Calldata missing for ${selectedRoute.join(' -> ')}.`);
          break;
        }
        const tx = {
          to: config.contract,
          value: amountInWei,
          data: txData,
          gasLimit,
          nonce: await provider.getTransactionCount(walletAddress, 'pending'),
        };
        // Dynamically set maxFeePerGas and maxPriorityFeePerGas
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
          logger.warn(`[✓] [${config.name}] ⚠️  Failed to fetch base fee: ${feeError.message}. Using default gas fees.`);
          const fallback = isEthersV6 ? ethers.parseUnits('2', 'gwei') : ethers.utils.parseUnits('2', 'gwei');
          tx.maxPriorityFeePerGas = fallback;
          tx.maxFeePerGas = fallback;
        }
        try {
          const gasEstimate = await provider.estimateGas(tx);
          tx.gasLimit = isEthersV6 ? (gasEstimate * 120n) / 100n : gasEstimate.mul(120).div(100);
        } catch (gasError) {
          logger.warn(`[✓] [${config.name}] ⚠️  Gas estimation failed. Using default: ${gasLimit}`);
        }
        try {
          await provider.call(tx);
        } catch (simulationError) {
          logger.error(`[✓] [${config.name}] ❌ Simulation failed: ${simulationError.reason || simulationError.message}`);
          break;
        }
        const txResponse = await wallet.sendTransaction(tx);
        logger.info(`[✓] [${config.name}] 📤 Transaction sent! Hash: ${txResponse.hash}`);
        logger.loading(`[✓] [${config.name}] ⏳ Waiting for confirmation...`);
        const receipt = await txResponse.wait();
        if (receipt.status === 1) {
          successCount++;
          logger.success(`[✓] [${config.name}] ✅ Swap ${i + 1} completed successfully!`);
          logger.success(`[✓] [${config.name}] 🎯 Route: ETH -> ${currentToken}`);
          logger.success(`[✓] [${config.name}] 💰 Amount: ${ethAmount} ETH`);
          logger.success(`[✓] [${config.name}] ⛽ Gas used: ${receipt.gasUsed}`);
          logger.success(`[✓] [${config.name}] 🔗 TX: ${config.explorer}${txResponse.hash}`);
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
          await checkSwapStatus(txResponse.hash, config.chainUid, walletAddress, provider, logger, meta);
          break;
        } else {
          failCount++;
          logger.error(`[✓] [${config.name}] ❌ Swap ${i + 1} failed: Transaction failed`);
          logger.error(`[✓] [${config.name}] 🎯 Failed route: ETH -> ${currentToken}`);
          break;
        }
      } catch (error) {
        failCount++;
        logger.error(`[✓] [${config.name}] ❌ Swap ${i + 1} failed: ${error.message}`);
      }
      attempt++;
      if (attempt < maxAttempts) {
        currentToken = supportedTargetTokens[Math.floor(Math.random() * supportedTargetTokens.length)];
        currentChainUid = tokenChainUids[currentToken] || 'sepolia';
        logger.warn(`[✓] [${config.name}] 🔄 Retrying with fallback token: ${currentToken}`);
      }
    }
    if (i < numTransactions - 1) {
      await randomDelay(SETTINGS.PAUSE_BETWEEN_SWAPS[0] * 1000, SETTINGS.PAUSE_BETWEEN_SWAPS[1] * 1000);
    }
  }
  // Final summary
  logger.info(`[✓] [${config.name}] 📊 Final Results:`);
  logger.info(`[✓] [${config.name}] ✅ Successful swaps: ${successCount}/${numTransactions}`);
  logger.info(`[✓] [${config.name}] ❌ Failed swaps: ${failCount}/${numTransactions}`);
  logger.info(`[✓] [${config.name}] 🏁 Wallet processing completed`);

  return {
    success: successCount > 0,
    successCount,
    failCount,
    totalSwaps: numTransactions
  };
};

// Helper: fetchAvailableTokens
const fetchAvailableTokens = async (chainUid, logger) => {
  try {
    const payload = {
      query: `
        query CODEGEN_GENERATED_TOKEN_TOKEN_METADATAS($chain_uids: [String!], $token_token_metadatas_limit: Int, $token_token_metadatas_verified: Boolean) {
          token {
            token_metadatas(chain_uids: $chain_uids, limit: $token_token_metadatas_limit, verified: $token_token_metadatas_verified) {
              tokenId
              chain_uids
              __typename
            }
            __typename
          }
        }
      `,
      variables: {
        chain_uids: [chainUid],
        token_token_metadatas_limit: 1000,
        token_token_metadatas_verified: true,
      },
    };
    logger.debug(`[fetchAvailableTokens] Payload: ${JSON.stringify(payload)}`);
    const response = await axios.post(
      'https://testnet.api.euclidprotocol.com/graphql',
      payload,
      {
        headers: { 'accept': 'application/json', 'content-type': 'application/json' },
        timeout: 5000,
      }
    );
    logger.debug(`[fetchAvailableTokens] Response: ${JSON.stringify(response.data)}`);
    return response.data.data.token.token_metadatas
      .filter(metadata => metadata.chain_uids.includes(chainUid))
      .map(metadata => metadata.tokenId)
      .filter(token => token !== 'eth');
  } catch (error) {
    if (error.response) {
      logger.error(`[fetchAvailableTokens] API error ${error.response.status}: ${JSON.stringify(error.response.data)}`);
    } else {
      logger.error(`[✓] [${config.name}] ❌ API error: ${error.message}`);
    }
    return [];
  }
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
    const escrow = response.data.data.router.escrows.find(e => e.chain_uid === chainUid);
    return escrow ? parseInt(escrow.balance) : 0;
  } catch (error) {
    logger.error(`[✓] [${config.name}] ❌ Failed to fetch escrows for ${token}: ${error.message}`);
    return 0;
  }
};

// Helper: validateTokenRoutes
const validateTokenRoutes = async (token, chainUids, amountInWei, logger) => {
  try {
    const routesPayload = {
      external: true,
      token_in: 'eth',
      token_out: token,
      amount_in: amountInWei.toString(),
      chain_uids: chainUids,
      intermediate_tokens: ['euclid', 'mon', 'andr', 'usdc', 'usdt'],
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
    logger.debug(`[✓] [${config.name}] ⚠️  Route validation failed for ${token}: ${error.message}`);
    return false;
  }
};

// Helper: retry (copied from base/arbitrum modules for consistency)
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

// Helper: checkSwapStatus
const checkSwapStatus = async (txHash, chainUid, walletAddress, provider, logger, meta) => {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const response = await retry(() =>
        axios.post('https://testnet.api.euclidprotocol.com/api/v1/txn/track/swap', {
          chain: chainUid,
          tx_hash: txHash,
          meta: meta ? JSON.stringify(meta) : '',
        }, {
          headers: { 'accept': 'application/json', 'content-type': 'application/json', 'Referer': 'https://testnet.euclidswap.io/' },
          timeout: 5000,
        })
      );
      if (response.data.response.is_completed) {
        logger.success(`[✓] [${config.name}] ✅ Swap completed: ${txHash}`);
        return true;
      }
      if (SHOW_SWAP_PENDING_LOG.ethereum_sepolia) {
        logger.loading(`[✓] [${config.name}] ⏳ Swap pending (Attempt ${attempt}/10): ${txHash}`);
      }
    } catch (error) {
      logger.warn(`[✓] [${config.name}] ⚠️  Status check failed: ${error.message}. Verifying on-chain...`);
      try {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (receipt && receipt.status === 1) {
          logger.success(`[✓] [${config.name}] ✅ Swap confirmed on-chain: ${txHash}`);
          return true;
        }
      } catch (onChainError) {
        logger.debug(`[✓] [${config.name}] ⚠️  On-chain verification failed: ${onChainError.message}`);
      }
    }
    await randomDelay(30000, 30000); // 30 seconds fixed delay for status check
  }
  logger.error(`[✓] [${config.name}] ❌ Swap did not complete after 10 attempts: ${txHash}`);
  return false;
};

export default processSwap;