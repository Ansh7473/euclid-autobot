// config.js
export const SETTINGS = {
  THREADS: 1, // Number of wallets to process in parallel
  ATTEMPTS: 1, // Number of retry attempts for failed swaps
  PAUSE_BETWEEN_ATTEMPTS: [3, 8], // Delay between retry attempts (seconds)
  PAUSE_BETWEEN_SWAPS: [1, 8], // Delay between swaps for a wallet (seconds)
  RANDOM_INITIALIZATION_PAUSE: [1,2], // Initial delay for each wallet (seconds)
};



//[✗] No supported tokens with valid routes on Base Sepolia.  // [✗] No supported tokens with valid routes on Base Sepolia.
//NOTE: // if no route try incresing amount 


export const FLOW = {
  arbitrum: {
    NUMBER_OF_SWAPS: [2, 6],
    AMOUNT_TO_SWAP: [0.0031, 0.0032], //min 0.0018 for now  // if no route try incresing amount 
  },
  base: {
    NUMBER_OF_SWAPS: [1, 1],
    AMOUNT_TO_SWAP: [0.0031, 0.0032], //min 0.0018 for now  // if no route try incresing amount 
  },
  ethereum_sepolia: {
    NUMBER_OF_SWAPS: [3, 6],
    AMOUNT_TO_SWAP: [0.003, 0.0031], //min 0.0018 for now  // if no route try incresing amount 
  },
  monad: {
    NUMBER_OF_SWAPS: [3, 6],
    AMOUNT_TO_SWAP: [0.0021, 0.0022], //min 0.0018 for now  // if no route try incresing amount 
  },
  megaeth: {
    NUMBER_OF_SWAPS: [3, 6],
    AMOUNT_TO_SWAP: [0.0031, 0.0032],   //min 0.002 for now  // if no route try incresing amount 
  },
  somnia: {
    NUMBER_OF_SWAPS: [3, 6],
    AMOUNT_TO_SWAP: [0.0021, 0.0022], //min 0.0018 for now  // if no route try incresing amount 
  },
  optimism: {
    NUMBER_OF_SWAPS: [3, 6],
    AMOUNT_TO_SWAP: [0.003, 0.0031], //min 0.0018 for now  // if no route try incresing amount 
  },
  linea: {
    NUMBER_OF_SWAPS: [3, 6],
    AMOUNT_TO_SWAP: [0.0031, 0.0032], //min 0.0018 for now  // if no route try incresing amount 
  },
  soneium: {
    NUMBER_OF_SWAPS: [3, 6],
    AMOUNT_TO_SWAP: [0.0031, 0.0032], //min 0.0018 for now  // if no route try incresing amount 
  },
  osmosis: {
    NUMBER_OF_SWAPS: [3, 6],
    AMOUNT_TO_SWAP: [2, 3], // OSMO amounts for testnet
  },
  oraichain: {
    NUMBER_OF_SWAPS: [3, 6],
    AMOUNT_TO_SWAP: [4, 5], // ORAI amounts for testnet
  },
};


//if you understand you use below features also 👇🏼 
 
export const SHOW_SWAP_PENDING_LOG = {   
  arbitrum: false,
  base: false,
  ethereum_sepolia: false,
  monad: false,
  megaeth: false,
  somnia: false,
  optimism: false,
  linea: false,
  soneium: false,
  osmosis: true,
  oraichain: true,
};   

export const RETRY = {
  ATTEMPTS: 3, // Default retry attempts for all chains
  DELAY: [3000, 5000], // Default delay between retries (ms)
};

export const CHECK_SWAP_STATUS = {
  arbitrum: { MAX_ATTEMPTS: 1, DELAY: 3000 },
  base: { MAX_ATTEMPTS: 10, DELAY: 30000 },
  ethereum_sepolia: { MAX_ATTEMPTS: 10, DELAY: 30000 },
  monad: { MAX_ATTEMPTS: 2, DELAY: 30000 },
  megaeth: { MAX_ATTEMPTS: 10, DELAY: 30000 },
  somnia: { MAX_ATTEMPTS: 10, DELAY: 30000 },
  optimism: { MAX_ATTEMPTS: 10, DELAY: 30000 },
  linea: { MAX_ATTEMPTS: 10, DELAY: 30000 },
  soneium: { MAX_ATTEMPTS: 10, DELAY: 30000 },
  osmosis: { MAX_ATTEMPTS: 5, DELAY: 15000 },
  oraichain: { MAX_ATTEMPTS: 5, DELAY: 15000 },
};

export const randomDelay = (min = 2000, max = 5000, context = '') => {
  const delay = (min === max) ? min : Math.floor(Math.random() * (max - min + 1)) + min;
  if (typeof global !== 'undefined' && global.logger && context) {
    global.logger.loading(`[Delay] Waiting ${Math.round(delay / 1000)}s (${context})...`);
  } else if (context) {
    console.log(`[Delay] Waiting ${Math.round(delay / 1000)}s (${context})...`);
  }
  return new Promise(resolve => setTimeout(resolve, delay));
};

// Helper to get random int/float between min and max (inclusive)
export function getRandomInRange(min, max, isFloat = false) {
  if (isFloat) {
    return Math.random() * (max - min) + min;
  } else {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
}
