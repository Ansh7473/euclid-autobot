## 🚀 Quick Start
@@ -88,22 +10,7 @@ The enhanced automation interface provides:
- **Node.js** 18+ installed
- **NPM** package manager
- **Private keys** for wallet addresses
- **Testnet tokens** on supported chains

### Installation

```bash
# Clone the repository
 git clone https://github.com/Ansh7473/euclid-autobot.git
cd euclid-autobot

# Install dependencies
npm install

# Configure your private keys
echo "0x1234..." > private_keys.txt

# For Cosmos chains (optional)
- **Testnet tokens** on supported chains Hy
echo "cosmos_private_key_here" > cosmos_keys.txt

# Start the bot
```
## 📁 Project Structure

```
📦 euclid-bot/
├── 📄 main.js                    # Main application entry point
├── 📄 config.js                  # Global configuration settings
├── 📄 logger.js                  # Professional logging utilities
├── 📁 Chain Modules/
│   ├── 📄 euclid-arbitrum-sepolia.js
│   ├── 📄 euclid-base-sepolia.js
│   ├── 📄 euclid-ethereum-sepolia.js
│   ├── 📄 euclid-linea.js
│   ├── 📄 euclid-megaeth.js
│   ├── 📄 euclid-monad.js
│   ├── 📄 euclid-optimism.js
│   ├── 📄 euclid-osmosis.js
│   ├── 📄 euclid-somnia.js
│   └── 📄 euclid-soneium.js
├── 📄 private_keys.txt           # evm wallet private keys module(1-9) usage
├── 📄 cosmos_keys.txt            # Cosmos wallet keys module(10-11)usage
└── 📄 package.json               # Dependencies
```

## ⚙️ Configuration

### Basic Settings

Edit `config.js` to customize your trading parameters:

```javascript
export const SETTINGS = {
  THREADS: 1,                    // Concurrent execution threads
  ATTEMPTS: 3,                   // Retry attempts per transaction
  PAUSE_BETWEEN_ATTEMPTS: [3, 8], // Delay between retries (seconds)
  PAUSE_BETWEEN_SWAPS: [1, 8],   // Delay between swaps (seconds)
  RANDOM_INITIALIZATION_PAUSE: [1, 2] // Initial randomization
};
```

### Wallet Configuration

**EVM Chains**: Add your private keys to `private_keys.txt` (one per line)
```
0x1234567890abcdef...
0xabcdef1234567890...
```

**Cosmos Chains**: Add Cosmos keys to `cosmos_keys.txt` 
```
cosmos_private_key_1
cosmos_private_key_2
```

## 🎯 Usage Examples

### Interactive Mode
```bash
node main.js
```
Follow the interactive prompts to select:
- Target blockchain networks
- Number of transactions
- ETH amount per swap
- Delay between transactions

### Automated Trading
The bot supports various trading strategies:
- **Single Chain Swaps**: Trade within one blockchain
- **Cross-Chain Arbitrage**: Profit from price differences across chains
- **Liquidity Provision**: Provide liquidity to earn fees
- **Random Trading**: Randomized trading patterns

## 📊 Monitoring & Logs

The bot provides comprehensive logging with professional formatting:

```
[✓] Arbitrum Sepolia: 🚀 Starting same-chain swap automation...
[✓] Arbitrum Sepolia: 👛 Processing 5 wallets
[✓] Arbitrum Sepolia: 📋 Available tokens: euclid, usdc, usdt, mon
[✓] Arbitrum Sepolia: 🔄 Swap type: Random Swap
[✓] Arbitrum Sepolia: 📊 Transactions: 10
[✓] Arbitrum Sepolia: 💰 ETH per transaction: 0.001–0.005 ETH (random)
[✓] Arbitrum Sepolia: ⛽ Total ETH (incl. gas): 0.051 ETH
[✓] Arbitrum Sepolia: ⏱️ Delay range: 3–8 seconds
```

## 🛡️ Security Features

- **Private Key Protection**: Keys stored locally, never transmitted
- **Transaction Simulation**: All transactions simulated before execution
- **Error Handling**: Comprehensive error catching and recovery
- **Rate Limiting**: Built-in delays to prevent API rate limits
- **Gas Optimization**: Smart gas estimation and fee management

## 🔧 Advanced Configuration

### Custom RPC Endpoints
Each chain module can be configured with custom RPC endpoints for better performance or privacy.

### Proxy Support
Configure proxy servers in `proxies.txt` for enhanced privacy and rate limit avoidance.

### Gas Optimization
The bot automatically optimizes gas fees based on network conditions and includes:
- EIP-1559 fee estimation
- Dynamic gas limit adjustment
- Failed transaction retry with higher gas

## 📈 Performance

- **Multi-threaded**: Concurrent execution across multiple chains
- **Optimized API Calls**: Efficient API usage with connection pooling
- **Error Recovery**: Automatic retry mechanisms with exponential backoff
- **Memory Efficient**: Optimized for long-running operations

## 🤝 Contributing

We welcome contributions! Please follow these steps:

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Commit** your changes (`git commit -m 'Add amazing feature'`)
4. **Push** to the branch (`git push origin feature/amazing-feature`)
5. **Open** a Pull Request

### Development Guidelines
- Follow existing code style and patterns
- Add comprehensive comments for complex logic
- Test on testnet before submitting
- Update documentation for new features



## ⚠️ Disclaimer

This bot is designed for **educational and testnet purposes only**. 

- **Not Financial Advice**: This software is for educational purposes
- **Use at Your Own Risk**: Trading involves risk of loss
- **Testnet Only**: Optimized for testnet environments
- **No Warranty**: Software provided "as is" without warranty



<div align="center">

**Made with ❤️ for the Euclid Protocol Community**

⭐ **Star this repo if it helped you!** ⭐

</div>
