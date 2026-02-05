import dotenv from 'dotenv';

dotenv.config();

// Валідація обов'язкових змінних для Web3 автентифікації
const requiredEnvVars = [
  'ASTERDEX_USER_ADDRESS',      // ⚠️ ЗМІНЕНО: Main wallet address
  'ASTERDEX_SIGNER_ADDRESS',    // ⚠️ ЗМІНЕНО: API wallet address
  'ASTERDEX_PRIVATE_KEY',       // ⚠️ ЗМІНЕНО: Private key API wallet
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHANNEL_ID'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

export const config = {
  // AsterDex API (Web3 Authentication)
  asterdex: {
    userAddress: process.env.ASTERDEX_USER_ADDRESS,          // Main wallet address
    signerAddress: process.env.ASTERDEX_SIGNER_ADDRESS,      // API wallet address  
    privateKey: process.env.ASTERDEX_PRIVATE_KEY,            // Private key
    testnet: process.env.ASTERDEX_TESTNET === 'true',
    positionMode: (process.env.ASTERDEX_POSITION_MODE || 'ONE_WAY').toUpperCase(),
    baseURL: process.env.ASTERDEX_TESTNET === 'true' 
      ? 'https://testnet-fapi.asterdex.com'
      : 'https://fapi.asterdex.com'
  },

  // Telegram
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    channelId: process.env.TELEGRAM_CHANNEL_ID
  },

  // Risk Management
  risk: {
    percentage: parseFloat(process.env.RISK_PERCENTAGE || '2.5'),
    leverage: parseInt(process.env.LEVERAGE || '20'),
    takeProfitPercent: parseFloat(process.env.TAKE_PROFIT_PERCENT || '0.5'),
    stopLossPercent: parseFloat(process.env.STOP_LOSS_PERCENT || '0.3')
  },

  // Trading Settings
  trading: {
    allowedSymbols: (process.env.ALLOWED_SYMBOLS || 'ADAUSDT,TAOUSDT,UNIUSDT').split(',').map(s => s.trim()),
    maxDailyTrades: parseInt(process.env.MAX_DAILY_TRADES || '20'),
    maxOpenPositions: parseInt(process.env.MAX_OPEN_POSITIONS || '3'),
    dryRun: process.env.DRY_RUN === 'true'
  },

  // Trading Hours (UTC)
  tradingHours: {
    enabled: process.env.TRADING_HOURS_ENABLED === 'true',
    startHour: parseInt(process.env.TRADING_START_HOUR || '6'),
    endHour: parseInt(process.env.TRADING_END_HOUR || '22'),
    timezone: process.env.TIMEZONE || 'UTC'
  }
};

// Валідація конфігурації
if (config.risk.percentage <= 0 || config.risk.percentage > 100) {
  throw new Error('RISK_PERCENTAGE must be between 0 and 100');
}

if (config.risk.leverage <= 0 || config.risk.leverage > 100) {
  throw new Error('LEVERAGE must be between 1 and 100');
}

if (config.trading.maxDailyTrades <= 0) {
  throw new Error('MAX_DAILY_TRADES must be greater than 0');
}

if (config.trading.maxOpenPositions <= 0) {
  throw new Error('MAX_OPEN_POSITIONS must be greater than 0');
}

if (config.tradingHours.startHour < 0 || config.tradingHours.startHour > 23) {
  throw new Error('TRADING_START_HOUR must be between 0 and 23');
}

if (config.tradingHours.endHour < 0 || config.tradingHours.endHour > 23) {
  throw new Error('TRADING_END_HOUR must be between 0 and 23');
}

// Валідація Ethereum адрес
if (!config.asterdex.userAddress.startsWith('0x') || config.asterdex.userAddress.length !== 42) {
  throw new Error('ASTERDEX_USER_ADDRESS must be a valid Ethereum address (0x...)');
}

if (!config.asterdex.signerAddress.startsWith('0x') || config.asterdex.signerAddress.length !== 42) {
  throw new Error('ASTERDEX_SIGNER_ADDRESS must be a valid Ethereum address (0x...)');
}

if (!config.asterdex.privateKey.startsWith('0x') || config.asterdex.privateKey.length !== 66) {
  throw new Error('ASTERDEX_PRIVATE_KEY must be a valid Ethereum private key (0x... 64 hex chars)');
}

export default config;
