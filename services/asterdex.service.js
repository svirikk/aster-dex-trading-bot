import axios from 'axios';
import { config } from '../config/settings.js';
import logger from '../utils/logger.js';

// ⚠️ CRITICAL: AsterDex використовує Web3 автентифікацію!
// Потрібно встановити: npm install ethers@^6

import { ethers } from 'ethers';

class AsterdexService {
  constructor() {
    // ⚠️ ЗМІНЕНО: AsterDex потребує wallet addresses та private key
    this.userAddress = config.asterdex.userAddress;  // Main wallet address
    this.signerAddress = config.asterdex.signerAddress;  // API wallet address
    this.privateKey = config.asterdex.privateKey;  // Private key API wallet
    this.baseURL = config.asterdex.baseURL;
    this.isConnected = false;
    
    // Rate limiting tracking
    this.lastRequestTime = 0;
    this.minRequestInterval = 100;
    
    // Nonce tracking для унікальності
    this._lastMs = 0;
    this._i = 0;
  }

  /**
   * Генерує унікальний nonce в мікросекундах
   */
  getNonce() {
    const nowMs = Math.floor(Date.now());
    
    if (nowMs === this._lastMs) {
      this._i += 1;
    } else {
      this._lastMs = nowMs;
      this._i = 0;
    }
    
    return nowMs * 1_000_000 + this._i;
  }

  /**
   * Створює EIP-712 підпис для запиту (Web3 автентифікація)
   */
  async createWeb3Signature(params) {
    try {
      // 1. Додаємо nonce, user, signer
      const nonce = this.getNonce();
      const allParams = {
        ...params,
        nonce: nonce.toString(),
        user: this.userAddress,
        signer: this.signerAddress
      };

      // 2. Сортуємо параметри по ключах (ASCII order)
      const sortedKeys = Object.keys(allParams).sort();
      const paramString = sortedKeys
        .map(key => `${key}=${allParams[key]}`)
        .join('&');

      // 3. Створюємо EIP-712 typed data
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

      // 4. Підписуємо через ethers.js
      const wallet = new ethers.Wallet(this.privateKey);
      const signature = await wallet.signTypedData(
        typedData.domain,
        { Message: typedData.types.Message },
        typedData.message
      );

      return {
        params: allParams,
        signature,
        paramString
      };
    } catch (error) {
      logger.error(`[ASTERDEX] Error creating Web3 signature: ${error.message}`);
      throw error;
    }
  }

  /**
   * Виконує підписаний запит до API (Web3 authentication)
   */
  async signedRequest(method, endpoint, params = {}) {
    try {
      // Rate limiting
      const now = Date.now();
      const timeSinceLastRequest = now - this.lastRequestTime;
      if (timeSinceLastRequest < this.minRequestInterval) {
        await new Promise(resolve => setTimeout(resolve, this.minRequestInterval - timeSinceLastRequest));
      }
      this.lastRequestTime = Date.now();

      // Створюємо Web3 підпис
      const { params: signedParams, signature } = await this.createWeb3Signature(params);
      
      // Додаємо підпис
      signedParams.signature = signature;

      const requestConfig = {
        method,
        url: `${this.baseURL}${endpoint}`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'AsterDexBot/1.0'
        }
      };

      // Для GET/DELETE - параметри в URL
      if (method === 'GET' || method === 'DELETE') {
        const queryString = Object.keys(signedParams)
          .map(key => `${key}=${encodeURIComponent(signedParams[key])}`)
          .join('&');
        requestConfig.url += `?${queryString}`;
      } else {
        // Для POST/PUT - параметри в body
        requestConfig.data = signedParams;
      }

      const response = await axios(requestConfig);
      
      // Перевіряємо rate limits
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

  /**
   * Виконує публічний запит (без підпису)
   */
  async publicRequest(method, endpoint, params = {}) {
    try {
      const queryString = Object.keys(params)
        .map(key => `${key}=${params[key]}`)
        .join('&');
      
      const url = queryString 
        ? `${this.baseURL}${endpoint}?${queryString}`
        : `${this.baseURL}${endpoint}`;

      const response = await axios({
        method,
        url
      });

      return response.data;
    } catch (error) {
      logger.error(`[ASTERDEX] Public request error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Обробка помилок API
   */
  async handleApiError(error) {
    if (error.response) {
      const { status, data } = error.response;
      const code = data?.code;
      const msg = data?.msg || error.message;

      logger.error(`[ASTERDEX] API Error ${status}: Code ${code}, Message: ${msg}`);

      if (code === -1021) {
        throw new Error(`Timestamp sync error: ${msg}`);
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

  /**
   * Перевіряє з'єднання з API
   */
  async connect() {
    try {
      logger.info('[ASTERDEX] Connecting to AsterDex API...');
      
      // Перевірка ping
      await this.publicRequest('GET', '/fapi/v1/ping');
      
      // Перевірка серверного часу
      const timeResponse = await this.publicRequest('GET', '/fapi/v1/time');
      const serverTime = timeResponse.serverTime;
      const localTime = Date.now();
      const timeDiff = Math.abs(serverTime - localTime);
      
      if (timeDiff > 5000) {
        logger.warn(`[ASTERDEX] Time difference with server: ${timeDiff}ms`);
      }
      
      // ⚠️ ЗМІНЕНО: Перевірка аутентифікації
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

  /**
   * Отримує баланс USDT
   */
  async getUSDTBalance() {
    try {
      // ⚠️ ЗМІНЕНО: Використовуємо v3 endpoint
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

  /**
   * Отримує інформацію про символ
   */
  async getSymbolInfo(symbol) {
    try {
      // ⚠️ ЗМІНЕНО: Використовуємо v3 endpoint
      const response = await this.publicRequest('GET', '/fapi/v3/exchangeInfo');
      
      const symbolData = response.symbols?.find(s => s.symbol === symbol);
      
      if (!symbolData) {
        throw new Error(`Symbol ${symbol} not found`);
      }

      // Витягуємо фільтри
      const priceFilter = symbolData.filters?.find(f => f.filterType === 'PRICE_FILTER');
      const lotSizeFilter = symbolData.filters?.find(f => f.filterType === 'LOT_SIZE');
      const minNotional = symbolData.filters?.find(f => f.filterType === 'MIN_NOTIONAL');

      return {
        symbol: symbolData.symbol,
        status: symbolData.status || symbolData.contractStatus,  // ⚠️ ДОДАНО: contractStatus
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

  /**
   * Отримує поточну ціну символу
   */
  async getCurrentPrice(symbol) {
    try {
      // ⚠️ ЗМІНЕНО: Використовуємо v3 endpoint
      const response = await this.publicRequest('GET', '/fapi/v3/ticker/price', { symbol });
      
      const price = parseFloat(response.price);
      logger.info(`[ASTERDEX] Current price for ${symbol}: ${price}`);
      
      return price;
    } catch (error) {
      logger.error(`[ASTERDEX] Error getting current price for ${symbol}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Встановлює плече для символу
   */
  async setLeverage(symbol, leverage) {
    try {
      logger.info(`[ASTERDEX] Setting leverage ${leverage}x for ${symbol}...`);
      
      // ⚠️ ЗМІНЕНО: Використовуємо v3 endpoint
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

  /**
   * Відкриває Market ордер
   */
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

      // ⚠️ ЗМІНЕНО: Використовуємо v3 endpoint
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

  /**
   * Встановлює Take Profit
   */
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

      // ⚠️ ЗМІНЕНО: Використовуємо v3 endpoint
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

  /**
   * Встановлює Stop Loss
   */
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

      // ⚠️ ЗМІНЕНО: Використовуємо v3 endpoint
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

  /**
   * Отримує відкриті позиції
   */
  async getOpenPositions(symbol = null) {
    try {
      const params = symbol ? { symbol } : {};
      // ⚠️ ЗМІНЕНО: Використовуємо v3 endpoint
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

  /**
   * Перевіряє чи є відкрита позиція по символу
   */
  async hasOpenPosition(symbol) {
    const positions = await this.getOpenPositions(symbol);
    return positions.length > 0;
  }

  /**
   * Отримує історію угод
   */
  async getTradeHistory(symbol = null, limit = 50) {
    try {
      const params = { limit };
      if (symbol) {
        params.symbol = symbol;
      }

      // ⚠️ ЗМІНЕНО: Використовуємо v3 endpoint
      const response = await this.signedRequest('GET', '/fapi/v3/userTrades', params);

      return Array.isArray(response) ? response : [];
    } catch (error) {
      logger.error(`[ASTERDEX] Error getting trade history: ${error.message}`);
      throw error;
    }
  }

  /**
   * Визначає positionSide на основі direction та режиму
   */
  getPositionSide(direction) {
    const mode = (config.asterdex.positionMode || 'ONE_WAY').toUpperCase();
    if (mode === 'HEDGE') {
      return direction; // "LONG" або "SHORT"
    }
    return 'BOTH';
  }

  /**
   * Отримує side для ордера на основі direction
   */
  getOrderSide(direction) {
    return direction === 'LONG' ? 'BUY' : 'SELL';
  }
}

const asterdexService = new AsterdexService();
export default asterdexService;
