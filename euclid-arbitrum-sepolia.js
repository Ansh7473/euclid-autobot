import { ethers } from 'ethers';
import axios from 'axios';
import { SETTINGS, randomDelay, SHOW_SWAP_PENDING_LOG } from './config.js';

// Detect ethers v6
const isEthersV6 = typeof ethers.parseEther === 'function';

const config = {
  rpc: 'https://sepolia-rollup.arbitrum.io/rpc',
  chainId: 421614,
  name: 'Arbitrum Sepolia',
  contract: '0x7f2cc9fe79961f628da671ac62d1f2896638edd5',
  explorer: 'https://sepolia.arbiscan.io/tx/',
  tokens: ['euclid', 'usdc', 'usdt', 'mon'],
  chainUid: 'arbitrum'
};

const privateKeys = (await import('fs/promises'))
  .readFile('private_keys.txt', 'utf8')
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

const processSwap = async (privateKey, swapType, numTransactions, minEthAmount, maxEthAmount, minDelay, maxDelay, requireConfirmation, logger) => {
  const provider = new ethers.JsonRpcProvider(config.rpc, config.chainId);
  const wallet = isEthersV6 ? new ethers.Wallet(privateKey, provider) : new ethers.Wallet(privateKey, provider);
  const walletAddress = wallet.address;
  logger.info(`Connected to wallet: ${walletAddress}`);
  logger.info(`Network: ${config.name} (Chain ID: ${config.chainId})`);

  // Determine ETH amounts
  const ethAmounts = ['1', '2'].includes(swapType)
    ? Array(numTransactions).fill(minEthAmount)
    : Array(numTransactions).fill(0).map(() => (minEthAmount + Math.random() * (maxEthAmount - minEthAmount)).toFixed(18));

  // Calculate total required ETH
  const gasEstimatePerTx = isEthersV6 ? ethers.parseEther('0.00009794') : ethers.utils.parseUnits('0.00009794', 'ether');
  let totalRequiredEth = BigInt(0);
  for (const ethAmount of ethAmounts) {
    const requiredEth = isEthersV6 ? ethers.parseEther(ethAmount) : ethers.utils.parseEther(ethAmount);
    const totalPerTx = isEthersV6 ? requiredEth + gasEstimatePerTx : requiredEth.add(gasEstimatePerTx);
    totalRequiredEth = isEthersV6 ? totalRequiredEth + totalPerTx : totalRequiredEth.add(totalPerTx);
  }

  const balance = await provider.getBalance(walletAddress);
  if (isEthersV6 ? balance < totalRequiredEth : balance.lt(totalRequiredEth)) {
    logger.error(`Insufficient ETH. Required: ${isEthersV6 ? ethers.formatEther(totalRequiredEth) : ethers.utils.formatEther(totalRequiredEth)} ETH, Available: ${isEthersV6 ? ethers.formatEther(balance) : ethers.utils.formatEther(balance)} ETH`);
    return false;
  }

  // Display summary
  logger.warn(`Summary for wallet ${walletAddress}:`);
  logger.step(`Swap type: ${swapType === '1' ? 'ETH to EUCLID' : swapType === '2' ? 'ETH to ANDR' : 'Random Swap'}`);
  logger.step(`Transactions: ${numTransactions}`);
  logger.step(`ETH per transaction: ${['1', '2'].includes(swapType) ? minEthAmount : `${minEthAmount}–${maxEthAmount}`} ETH${['1', '2'].includes(swapType) ? '' : ' (random)'}`);
  logger.step(`Total ETH (incl. gas): ${isEthersV6 ? ethers.formatEther(totalRequiredEth) : ethers.utils.formatEther(totalRequiredEth)} ETH`);
  logger.step(`Global delay between transactions: ${minDelay}–${maxDelay} seconds`);

  if (requireConfirmation) {
    const confirm = await (await import('readline/promises')).createInterface({ input: process.stdin, output: process.stdout }).question(`Continue with these settings for wallet ${walletAddress}? (y/n): `);
    if (confirm.toLowerCase() !== 'y') {
      logger.error(`Cancelled for wallet ${walletAddress}.`);
      return false;
    }
  } else {
    logger.step(`Auto-continuing for wallet ${walletAddress}`);
  }

  // Fetch and validate tokens
  const tokens = await fetchAvailableTokens(config.chainUid, logger);
  if (tokens.length === 0) {
    logger.error(`No tokens available on ${config.name}.`);
    return false;
  }
  logger.step(`Available tokens: ${tokens.join(', ')}`);

  const validTokens = [];
  const tokenChainUids = {
    euclid: 'arbitrum',
    mon: 'monad',
    usdc: 'monad',
    usdt: 'monad'
  };

  for (const token of ['euclid', 'mon', 'usdc', 'usdt']) {
    const destChainUid = tokenChainUids[token] || config.chainUid;
    const balance = await fetchEscrows(token, destChainUid, logger);
    logger.step(`${token.toUpperCase()} escrow on ${destChainUid}: ${balance}`);
    if (balance > 0 || (['1'].includes(swapType) && token === 'euclid') || (swapType === '2' && token === 'andr')) {
      validTokens.push(token);
    }
  }

  if (validTokens.length === 0) {
    logger.error(`No tokens with sufficient escrow balance on ${config.name}.`);
    return false;
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
    return false;
  }
  logger.step(`Supported target tokens: ${supportedTargetTokens.join(', ')}`);

  let gasLimit = 2500000;
  for (let i = 0; i < numTransactions; i++) {
    const ethAmount = ethAmounts[i];
    const amountInWei = isEthersV6 ? ethers.parseEther(ethAmount) : ethers.utils.parseEther(ethAmount);
    let currentToken = supportedTargetTokens[Math.floor(Math.random() * supportedTargetTokens.length)];
    let currentChainUid = tokenChainUids[currentToken] || 'vsl';
    logger.step(`Selected random token: ${currentToken} (chain: ${currentChainUid})`);

    let attempt = 0;
    const maxAttempts = supportedTargetTokens.length;

    while (attempt < maxAttempts) {
      logger.loading(`Transaction ${i + 1}/${numTransactions} (ETH to ${currentToken}, ${ethAmount} ETH) for wallet ${walletAddress}:`);
      try {
        const routesPayload = {
          external: true,
          token_in: 'eth',
          token_out: currentToken,
          amount_in: amountInWei.toString(),
          chain_uids: [config.chainUid, 'vsl'],
          intermediate_tokens: supportedTargetTokens.filter(t => t !== currentToken && t !== 'eth')
        };
        logger.step(`Requesting route: ETH -> ${currentToken} on ${config.name}`);
        const routesResponse = await retry(() =>
          axios.post('https://testnet.api.euclidprotocol.com/api/v1/routes?limit=10', routesPayload, {
            headers: { 'accept': 'application/json', 'content-type': 'application/json', 'Referer': 'https://testnet.euclidswap.io/' },
            timeout: 5000
          })
        );
        const routes = routesResponse.data.paths;
        if (!routes || routes.length === 0) {
          logger.warn(`No routes found for ETH -> ${currentToken}. Retrying with next token...`);
          break;
        }
        const selectedRouteIndex = Math.floor(Math.random() * routes.length);
        const selectedRoute = routes[selectedRouteIndex].path[0].route;
        const amountOut = routes[selectedRouteIndex].path[0].amount_out;
        logger.step(`Found ${routes.length} routes, selected: ${selectedRoute.join(' -> ')}, amount_out: ${amountOut}`);
        const slippage = 0.05;
        const minAmountOut = Math.floor(parseInt(amountOut) * (1 - slippage)).toString();

        const selectedRouteObj = routes[selectedRouteIndex].path[0];
        const amountOutForHops = selectedRouteObj.amount_out_for_hops || [];
        const chainUidInRoute = selectedRouteObj.chain_uid || 'vsl';
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
          logger.error(`Calldata missing for ${selectedRoute.join(' -> ')}.`);
          break;
        }

        const tx = {
          to: config.contract,
          value: amountInWei,
          data: txData,
          gasLimit,
          nonce: await provider.getTransactionCount(walletAddress, 'pending'),
        };

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
          tx.gasLimit = isEthersV6 ? (gasEstimate * 120n) / 100n : gasEstimate.mul(120).div(100);
        } catch (gasError) {
          logger.warn(`Gas estimation failed. Using default: ${gasLimit}`);
        }

        try {
          await provider.call(tx);
        } catch (simulationError) {
          logger.error(`Simulation failed: ${simulationError.reason || simulationError.message}`);
          break;
        }

        const txResponse = await wallet.sendTransaction(tx);
        logger.info(`Transaction sent! Hash: ${txResponse.hash}`);

        logger.loading(`Waiting for confirmation...`);
        const receipt = await txResponse.wait();

        if (receipt.status === 1) {
          logger.success(`Transaction successful! Gas used: ${receipt.gasUsed}`);
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
          logger.error(`Transaction failed.`);
          break;
        }
      } catch (error) {
        logger.error(`Error: ${error.message}`);
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
  logger.success(`All transactions completed for wallet ${walletAddress}!`);
  return true;
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
    const response = await axiosInstance.post(
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
    logger.error(`Failed to fetch tokens: ${error.message}`);
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
      token_in: 'eth',
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
        timeout: 5000,
      }
    );
    return response.data.paths && response.data.paths.length > 0;
  } catch (error) {
    logger.debug(`Route validation failed for ${token}: ${error.message}`);
    return false;
  }
};

// Helper: checkSwapStatus (Arbitrum Sepolia swap pending log)
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
        logger.success(`[Arbitrum Sepolia] Swap completed: ${txHash}`);
        return true;
      }
      if (SHOW_SWAP_PENDING_LOG.arbitrum) {
        logger.loading(`[Arbitrum Sepolia] Swap pending (Attempt ${attempt}/10): ${txHash}`);
      }
    } catch (error) {
      logger.warn(`[Arbitrum Sepolia] Status check failed: ${error.message}. Verifying on-chain...`);
      try {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (receipt && receipt.status === 1) {
          logger.success(`[Arbitrum Sepolia] Swap confirmed on-chain: ${txHash}`);
          return true;
        }
      } catch (onChainError) {
        logger.debug(`[Arbitrum Sepolia] On-chain verification failed: ${onChainError.message}`);
      }
    }
    await randomDelay(delay, delay + 5000);
  }
  logger.error(`[Arbitrum Sepolia] Swap did not complete after ${maxAttempts} attempts: ${txHash}`);
  return false;
};

export default processSwap;