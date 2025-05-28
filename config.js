// config.js
export const SETTINGS = {
  THREADS: 1, // Number of wallets to process in parallel
  ATTEMPTS: 3, // Number of retry attempts for failed swaps
  PAUSE_BETWEEN_ATTEMPTS: [3, 5], // Delay between retry attempts (seconds)
  PAUSE_BETWEEN_SWAPS: [3, 5], // Delay between swaps for a wallet (seconds)
  RANDOM_INITIALIZATION_PAUSE: [1, 3], // Initial delay for each wallet (seconds)
};

export const FLOW = {
  arbitrum: {
    NUMBER_OF_SWAPS: [2, 3],
    AMOUNT_TO_SWAP: [0.0008, 0.0009],
  },
  base: {
    NUMBER_OF_SWAPS: [1, 1],
    AMOUNT_TO_SWAP: [0.0008, 0.0009],
  },
  ethereum_sepolia: {
    NUMBER_OF_SWAPS: [1, 1],
    AMOUNT_TO_SWAP: [0.0008, 0.0009],
  },
  monad: {
    NUMBER_OF_SWAPS: [1, 1],
    AMOUNT_TO_SWAP: [0.00075, 0.0008],
  },
  megaeth: {
    NUMBER_OF_SWAPS: [1, 1],
    AMOUNT_TO_SWAP: [0.00075, 0.00081],
  },
  somnia: {
    NUMBER_OF_SWAPS: [1, 1],
    AMOUNT_TO_SWAP: [0.0008, 0.0009],
  },
};
            //added to manage this  :)
            //[⟳] [Base Sepolia] Swap pending (Attempt 1/10): ,,
            //[⟳] [Base Sepolia] Swap pending (Attempt 2/10): ,,
            //[⟳] [Base Sepolia] Swap pending (Attempt 3/10): ,,
            //[⟳] [Base Sepolia] Swap pending (Attempt 4/10): ,,
 
export const SHOW_SWAP_PENDING_LOG = {   
  arbitrum: false,
  base: true,
  ethereum_sepolia: false,
  monad: true,
  megaeth: true,
  somnia: true,
};   

export const randomDelay = (min = 2000, max = 5000, context = '') => {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  if (typeof global !== 'undefined' && global.logger && context) {
    global.logger.loading(`[Delay] Waiting ${Math.round(delay / 1000)}s (${context})...`);
  } else if (context) {
    console.log(`[Delay] Waiting ${Math.round(delay / 1000)}s (${context})...`);
  }
  return new Promise(resolve => setTimeout(resolve, delay));
};