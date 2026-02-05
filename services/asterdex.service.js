import axios from 'axios';
import { config } from '../config/settings.js';
import logger from '../utils/logger.js';
import { ethers } from 'ethers';

class AsterdexService {
  constructor() {
    this.userAddress = config.asterdex.userAddress;
    this.signerAddress = config.asterdex.signerAddress;
    this.privateKey = config.asterdex.privateKey;
    this.baseURL = config.asterdex.baseURL;
    this.isConnected = false;
    
    this.lastRequestTime = 0;
    this.minRequestInterval = 100;
    
    this._lastMs = 0;
    this._i = 0;
    
    // ✅ Time synchronization
    this.serverTimeOffset = 0; // різниця між server time і local time (ms)
    this.lastTimeSyncAt = 0;
    this.timeSyncInterval = 60000; // синхронізуємо час кожну хвилину
  }

  /**
   * Синхронізує час з сервером AsterDex
   */
  async syncServerTime() {
    try {
      const startTime = Date.now();
      const response = await this.publicRequest('GET', '/fapi/v1/time');
      const endTime = Date.now();
      
      const serverTime = response.serverTime;
      const localTime = Math.floor((startTime + endTime) / 2); // усереднений час з урахуванням затримки
      
      this.serverTimeOffset = serverTime - localTime;
      this.lastTimeSyncAt = Date.now();
      
      logger.info(`[ASTERDEX] Time synced: offset = ${this.serverTimeOffset}ms`);
      
      if (Math.abs(this.serverTimeOffset) > 1000) {
        logger.warn(`[ASTERDEX] Large time offset detected: ${this.serverTimeOffset}ms`);
      }
      
      return this.serverTimeOffset;
    } catch (error) {
      logger.error(`[ASTERDEX] Failed to sync time: ${error.message}`);
      throw error;
    }
  }

  /**
   * Отримує синхронізований час
   */
  getServerTime() {
    return Date.now() + this.serverTimeOffset;
  }

  /**
   * Перевіряє чи потрібна повторна синхронізація часу
   */
  async ensureTimeSync() {
    const now = Date.now();
    if (now - this.lastTimeSyncAt > this.timeSyncInterval) {
      await this.syncServerTime();
    }
  }

  getNonce() {
    const nowMs = Math.floor(this.getServerTime()); // ✅ використовуємо синхронізований час
    
    if (nowMs === this._lastMs) {
      this._i += 1;
    } else {
      this._lastMs = nowMs;
      this._i = 0;
    }
    
    return nowMs * 1_000_000 + this._i;
  }

  /**
   * Створює EIP-712 Web3 підпис
   */
  async createWeb3Signature(paramString) {
    try {
      const typedData = {
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" }
          ],
          Message: [
            { name: "msg", type: "string" }
          ]
        },
        primaryType: "Message",
        domain: {
          name: "AsterSignTransaction",
          version: "1",
          chainId: 1666,
          verifyingContract: "0x0000000000000000000000000000000000000000"
        },
        message: {
          msg: paramString
        }
      };

      const wallet = new ethers.Wallet(this.privateKey);
      const signature = await wallet.signTypedData(
        typedData.domain,
        { Message: typedData.types.Message },
        typedData.message
      );

      return signature;
    } catch (error) {
      logger.error(`[ASTERDEX] Error creating Web3 signature: ${error.message}`);
      throw error;
    }
  }

  /**
   * Виконує підписаний запит
   */
  async signedRequest(method, endpoint, params = {}) {
    try {
      // ✅ Перевіряємо синхронізацію часу перед кожним підписаним запитом
      await this.ensureTimeSync();

      // Rate limiting
      const now = Date.now();
      const timeSinceLastRequest = now - this.lastRequestTime;
      if (timeSinceLastRequest < this.minRequestInterval) {
        await new Promise(resolve => setTimeout(resolve, this.minRequestInterval - timeSinceLastRequest));
      }
      this.lastRequestTime = Date.now();

      const nonce = this.getNonce();
      
      // Формуємо параметри в правильному порядку
      let paramParts = [];
      
      // 1. Спочатку бізнес-параметри
      for (const key in params) {
        paramParts.push(`${key}=${params[key]}`);
      }
      
      // 2. Додаємо nonce, user, signer
      paramParts.push(`nonce=${nonce}`);
      paramParts.push(`user=${this.userAddress}`);
      paramParts.push(`signer=${this.signerAddress}`);
      
      const paramString = paramParts.join('&');
      
      logger.debug(`[ASTERDEX] Param string: ${paramString}`);

      // 3. Створюємо підпис
      const signature = await this.createWeb3Signature(paramString);
      
      // 4. Формуємо фінальний URL/body з підписом
      const finalUrl = `${this.baseURL}${endpoint}?${paramString}&signature=${signature}`;

      const requestConfig = {
        method,
        url: finalUrl,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'AsterDexBot/1.0'
        }
      };

      logger.debug(`[ASTERDEX] Request: ${method} ${finalUrl}`);

      const response = await axios(requestConfig);
      
      const usedWeight = response.headers['x-mbx-used-weight-1m'];
      if (usedWeight && parseInt(usedWeight) > 2000) {
        logger.warn(`[ASTERDEX] High API weight usage: ${usedWeight}/2400`);
      }

      return response.data;
    } catch (error) {
      await this.handleApiError(error);
      throw error;
    }
  }

  async publicRequest(method, endpoint, params = {}) {
    try {
      const queryString = Object.keys(params)
        .map(key => `${key}=${params[key]}`)
        .join('&');
      
      const url = queryString 
        ? `${this.baseURL}${endpoint}?${queryString}`
        : `${this.baseURL}${endpoint}`;

      const response = await axios({ method, url });
      return response.data;
    } catch (error) {
      logger.error(`[ASTERDEX] Public request error: ${error.message}`);
      throw error;
    }
  }

  async handleApiError(error) {
    if (error.response) {
      const { status, data } = error.response;
      const code = data?.code;
      const msg = data?.msg || error.message;

      logger.error(`[ASTERDEX] API Error ${status}: Code ${code}, Message: ${msg}`);

      // ✅ При помилці синхронізації часу - примусово синхронізуємо
      if (code === -1000 || code === -1021) {
        logger.warn('[ASTERDEX] Time sync error detected, forcing resync...');
        try {
          await this.syncServerTime();
          throw new Error(`Time sync error: ${msg}. Time has been resynced, please retry.`);
        } catch (syncError) {
          throw new Error(`Time sync failed: ${syncError.message}`);
        }
      }

      if (code === -429 || status === 429) {
        logger.warn('[ASTERDEX] Rate limit hit, waiting...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        throw new Error('Rate limit exceeded, please retry');
      }

      if (code === -2019) {
        throw new Error(`Insufficient margin: ${msg}`);
      }

      if (code === -4131) {
        throw new Error(`Market order rejected: ${msg}`);
      }

      throw new Error(`API Error: ${msg} (Code: ${code})`);
    } else {
      logger.error(`[ASTERDEX] Network error: ${error.message}`);
      throw error;
    }
  }

  async connect() {
    try {
      logger.info('[ASTERDEX] Connecting to AsterDex API...');
      
      await this.publicRequest('GET', '/fapi/v1/ping');
      
      // ✅ Синхронізуємо час при підключенні
      await this.syncServerTime();
      
      // Тестуємо підписаний запит
      await this.getUSDTBalance();
      
      this.isConnected = true;
      logger.info(`[ASTERDEX] ✅ Connected to AsterDex ${config.asterdex.testnet ? 'TESTNET' : 'MAINNET'}`);
      
      return true;
    } catch (error) {
      logger.error(`[ASTERDEX] Connection failed: ${error.message}`);
      this.isConnected = false;
      throw error;
    }
  }

  async getUSDTBalance() {
    try {
      const response = await this.signedRequest('GET', '/fapi/v3/balance', {});
      
      if (!Array.isArray(response)) {
        throw new Error('Invalid balance response format');
      }

      const usdtBalance = response.find(item => item.asset === 'USDT');
      
      if (!usdtBalance) {
        logger.warn('[ASTERDEX] USDT not found in wallet');
        return 0;
      }

      const availableBalance = parseFloat(usdtBalance.availableBalance || usdtBalance.balance || '0');
      logger.info(`[ASTERDEX] USDT Balance: ${availableBalance} USDT`);
      
      return availableBalance;
    } catch (error) {
      logger.error(`[ASTERDEX] Error getting balance: ${error.message}`);
      throw error;
    }
  }

  async getSymbolInfo(symbol) {
    try {
      const response = await this.publicRequest('GET', '/fapi/v3/exchangeInfo');
      
      const symbolData = response.symbols?.find(s => s.symbol === symbol);
      
      if (!symbolData) {
        throw new Error(`Symbol ${symbol} not found`);
      }

      const priceFilter = symbolData.filters?.find(f => f.filterType === 'PRICE_FILTER');
      const lotSizeFilter = symbolData.filters?.find(f => f.filterType === 'LOT_SIZE');
      const minNotional = symbolData.filters?.find(f => f.filterType === 'MIN_NOTIONAL');

      return {
        symbol: symbolData.symbol,
        status: symbolData.status || symbolData.contractStatus,
        baseAsset: symbolData.baseAsset,
        quoteAsset: symbolData.quoteAsset,
        pricePrecision: symbolData.pricePrecision || 4,
        quantityPrecision: symbolData.quantityPrecision || 4,
        tickSize: parseFloat(priceFilter?.tickSize || '0.01'),
        stepSize: parseFloat(lotSizeFilter?.stepSize || '0.001'),
        minQty: parseFloat(lotSizeFilter?.minQty || '0'),
        maxQty: parseFloat(lotSizeFilter?.maxQty || '999999999'),
        minNotional: parseFloat(minNotional?.notional || '0')
      };
    } catch (error) {
      logger.error(`[ASTERDEX] Error getting symbol info for ${symbol}: ${error.message}`);
      throw error;
    }
  }

  async getCurrentPrice(symbol) {
    try {
      const response = await this.publicRequest('GET', '/fapi/v3/ticker/price', { symbol });
      
      const price = parseFloat(response.price);
      logger.info(`[ASTERDEX] Current price for ${symbol}: ${price}`);
      
      return price;
    } catch (error) {
      logger.error(`[ASTERDEX] Error getting current price for ${symbol}: ${error.message}`);
      throw error;
    }
  }

  async setLeverage(symbol, leverage) {
    try {
      logger.info(`[ASTERDEX] Setting leverage ${leverage}x for ${symbol}...`);
      
      const response = await this.signedRequest('POST', '/fapi/v3/leverage', {
        symbol,
        leverage: leverage.toString()
      });

      logger.info(`[ASTERDEX] ✅ Leverage ${leverage}x set for ${symbol}`);
      return response;
    } catch (error) {
      if (error.message?.includes('leverage not modified') || 
          error.message?.includes('No need to change leverage')) {
        logger.info(`[ASTERDEX] ✅ Leverage already ${leverage}x for ${symbol}`);
        return { leverage, symbol };
      }
      
      logger.error(`[ASTERDEX] Error setting leverage: ${error.message}`);
      throw error;
    }
  }

  async openMarketOrder(symbol, side, quantity, positionSide = 'BOTH') {
    try {
      logger.info(`[ASTERDEX] Opening ${side} market order: ${quantity} ${symbol}...`);
      
      const params = {
        symbol,
        side,
        type: 'MARKET',
        quantity: quantity.toString(),
        positionSide
      };

      const response = await this.signedRequest('POST', '/fapi/v3/order', params);

      const orderId = response.orderId;
      const avgPrice = parseFloat(response.avgPrice || '0');
      
      logger.info(`[ASTERDEX] ✅ Market order opened: Order ID ${orderId}, Avg Price: ${avgPrice}`);
      
      return {
        orderId,
        symbol,
        side,
        quantity,
        avgPrice,
        status: response.status
      };
    } catch (error) {
      logger.error(`[ASTERDEX] Error opening market order: ${error.message}`);
      throw error;
    }
  }

  async setTakeProfit(symbol, side, price, quantity, positionSide = 'BOTH') {
    try {
      logger.info(`[ASTERDEX] Setting Take Profit: @ ${price} for ${symbol}...`);
      
      const tpSide = side === 'BUY' ? 'SELL' : 'BUY';
      
      const params = {
        symbol,
        side: tpSide,
        positionSide,
        type: 'TAKE_PROFIT',
        quantity: quantity.toString(),
        price: price.toString(),
        stopPrice: price.toString(),
        timeInForce: 'GTC',
        workingType: 'CONTRACT_PRICE'
      };

      const response = await this.signedRequest('POST', '/fapi/v3/order', params);

      logger.info(`[ASTERDEX] ✅ Take Profit set: Order ID ${response.orderId}`);
      
      return {
        orderId: response.orderId,
        price,
        type: 'TAKE_PROFIT'
      };
    } catch (error) {
      logger.error(`[ASTERDEX] Error setting Take Profit: ${error.message}`);
      throw error;
    }
  }

  async setStopLoss(symbol, side, price, quantity, positionSide = 'BOTH') {
    try {
      logger.info(`[ASTERDEX] Setting Stop Loss: @ ${price} for ${symbol}...`);
      
      const slSide = side === 'BUY' ? 'SELL' : 'BUY';
      
      const params = {
        symbol,
        side: slSide,
        positionSide,
        type: 'STOP',
        quantity: quantity.toString(),
        price: price.toString(),
        stopPrice: price.toString(),
        timeInForce: 'GTC',
        workingType: 'CONTRACT_PRICE'
      };

      const response = await this.signedRequest('POST', '/fapi/v3/order', params);

      logger.info(`[ASTERDEX] ✅ Stop Loss set: Order ID ${response.orderId}`);
      
      return {
        orderId: response.orderId,
        price,
        type: 'STOP'
      };
    } catch (error) {
      logger.error(`[ASTERDEX] Error setting Stop Loss: ${error.message}`);
      throw error;
    }
  }

  async getOpenPositions(symbol = null) {
    try {
      const params = symbol ? { symbol } : {};
      const response = await this.signedRequest('GET', '/fapi/v3/positionRisk', params);

      if (!Array.isArray(response)) {
        throw new Error('Invalid position response format');
      }

      const positions = response
        .filter(pos => Math.abs(parseFloat(pos.positionAmt || '0')) > 0)
        .map(pos => ({
          symbol: pos.symbol,
          positionSide: pos.positionSide,
          positionAmt: parseFloat(pos.positionAmt || '0'),
          entryPrice: parseFloat(pos.entryPrice || '0'),
          markPrice: parseFloat(pos.markPrice || '0'),
          unRealizedProfit: parseFloat(pos.unRealizedProfit || '0'),
          liquidationPrice: parseFloat(pos.liquidationPrice || '0'),
          leverage: parseFloat(pos.leverage || '1'),
          side: parseFloat(pos.positionAmt || '0') > 0 ? 'LONG' : 'SHORT',
          size: Math.abs(parseFloat(pos.positionAmt || '0'))
        }));

      return positions;
    } catch (error) {
      logger.error(`[ASTERDEX] Error getting open positions: ${error.message}`);
      throw error;
    }
  }

  async hasOpenPosition(symbol) {
    const positions = await this.getOpenPositions(symbol);
    return positions.length > 0;
  }

  async getTradeHistory(symbol = null, limit = 50) {
    try {
      const params = { limit };
      if (symbol) {
        params.symbol = symbol;
      }

      const response = await this.signedRequest('GET', '/fapi/v3/userTrades', params);

      return Array.isArray(response) ? response : [];
    } catch (error) {
      logger.error(`[ASTERDEX] Error getting trade history: ${error.message}`);
      throw error;
    }
  }

  getPositionSide(direction) {
    const mode = (config.asterdex.positionMode || 'ONE_WAY').toUpperCase();
    if (mode === 'HEDGE') {
      return direction;
    }
    return 'BOTH';
  }

  getOrderSide(direction) {
    return direction === 'LONG' ? 'BUY' : 'SELL';
  }
}

const asterdexService = new AsterdexService();
export default asterdexService;
