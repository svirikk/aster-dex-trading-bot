import axios from 'axios';
import crypto from 'crypto';
import { config } from '../config/settings.js';
import logger from '../utils/logger.js';

class AsterdexService {
  constructor() {
    this.apiKey = config.asterdex.apiKey;
    this.apiSecret = config.asterdex.apiSecret;
    this.baseURL = config.asterdex.baseURL;
    this.isConnected = false;
    
    // Rate limiting tracking
    this.lastRequestTime = 0;
    this.minRequestInterval = 100; // 100ms between requests
  }

  /**
   * Створює підпис HMAC SHA256 для запиту
   */
  createSignature(queryString) {
    return crypto
      .createHmac('sha256', this.apiSecret)
      .update(queryString)
      .digest('hex');
  }

  /**
   * Виконує підписаний запит до API
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

      const timestamp = Date.now();
      const recvWindow = 5000; // 5 seconds
      const allParams = { ...params, timestamp, recvWindow };
      
      // Створюємо query string
      const queryString = Object.keys(allParams)
        .sort() // Сортуємо для консистентності
        .map(key => `${key}=${allParams[key]}`)
        .join('&');
      
      // Створюємо підпис
      const signature = this.createSignature(queryString);
      const finalQuery = `${queryString}&signature=${signature}`;
      
      // Формуємо URL
      const url = method === 'GET' || method === 'DELETE'
        ? `${this.baseURL}${endpoint}?${finalQuery}`
        : `${this.baseURL}${endpoint}`;

      const requestConfig = {
        method,
        url,
        headers: {
          'X-MBX-APIKEY': this.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      };

      // Для POST/PUT передаємо дані в body
      if (method === 'POST' || method === 'PUT') {
        requestConfig.data = finalQuery;
      }

      const response = await axios(requestConfig);
      
      // Перевіряємо rate limits з headers
      const usedWeight = response.headers['x-mbx-used-weight-1m'];
      const orderCount = response.headers['x-mbx-order-count-1m'];
      
      if (usedWeight && parseInt(usedWeight) > 2000) {
        logger.warn(`[ASTERDEX] High API weight usage: ${usedWeight}/2400`);
      }
      
      if (orderCount && parseInt(orderCount) > 1000) {
        logger.warn(`[ASTERDEX] High order count: ${orderCount}/1200`);
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

      // Retry логіка для певних помилок
      if (code === -1021) {
        // INVALID_TIMESTAMP - sync часу
        logger.warn('[ASTERDEX] Timestamp sync issue detected');
        throw new Error(`Timestamp sync error: ${msg}`);
      }

      if (code === -429 || status === 429) {
        // TOO_MANY_REQUESTS
        logger.warn('[ASTERDEX] Rate limit hit, waiting...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        throw new Error('Rate limit exceeded, please retry');
      }

      if (code === -2019) {
        // MARGIN_NOT_SUFFICIENT
        throw new Error(`Insufficient margin: ${msg}`);
      }

      if (code === -4131) {
        // MARKET_ORDER_REJECT
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
      
      // Перевірка аутентифікації через отримання балансу
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
      const response = await this.signedRequest('GET', '/fapi/v2/balance');
      
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
      const response = await this.publicRequest('GET', '/fapi/v1/exchangeInfo');
      
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
        status: symbolData.status,
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
      const response = await this.publicRequest('GET', '/fapi/v1/ticker/price', { symbol });
      
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
      
      const response = await this.signedRequest('POST', '/fapi/v1/leverage', {
        symbol,
        leverage: leverage.toString()
      });

      logger.info(`[ASTERDEX] ✅ Leverage ${leverage}x set for ${symbol}`);
      return response;
    } catch (error) {
      // Якщо leverage вже встановлене - ігноруємо помилку
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
   * Відкриває Market ордер (ВХІД В ПОЗИЦІЮ)
   * Комісія: 0.035% (taker)
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

      const response = await this.signedRequest('POST', '/fapi/v1/order', params);

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
   * Встановлює Take Profit (LIMIT ORDER!)
   * Комісія: 0.01% (maker) - економія 7x порівняно з MARKET
   */
  async setTakeProfit(symbol, side, price, quantity, positionSide = 'BOTH') {
    try {
      logger.info(`[ASTERDEX] Setting Take Profit LIMIT: @ ${price} for ${symbol}...`);
      
      // КРИТИЧНО: Використовуємо ПРОТИЛЕЖНУ сторону!
      // Для LONG позиції (BUY entry) -> TP має бути SELL
      // Для SHORT позиції (SELL entry) -> TP має бути BUY
      const tpSide = side === 'BUY' ? 'SELL' : 'BUY';
      
      const params = {
        symbol,
        side: tpSide,
        positionSide,
        type: 'TAKE_PROFIT', // ← LIMIT версія!
        quantity: quantity.toString(),
        price: price.toString(),
        stopPrice: price.toString(), // Trigger ціна
        timeInForce: 'GTC',
        workingType: 'CONTRACT_PRICE'
      };

      const response = await this.signedRequest('POST', '/fapi/v1/order', params);

      logger.info(`[ASTERDEX] ✅ Take Profit LIMIT set: Order ID ${response.orderId}`);
      
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
   * Встановлює Stop Loss (LIMIT ORDER!)
   * Комісія: 0.01% (maker) - економія 7x порівняно з MARKET
   */
  async setStopLoss(symbol, side, price, quantity, positionSide = 'BOTH') {
    try {
      logger.info(`[ASTERDEX] Setting Stop Loss LIMIT: @ ${price} for ${symbol}...`);
      
      // КРИТИЧНО: Використовуємо ПРОТИЛЕЖНУ сторону!
      // Для LONG позиції (BUY entry) -> SL має бути SELL
      // Для SHORT позиції (SELL entry) -> SL має бути BUY
      const slSide = side === 'BUY' ? 'SELL' : 'BUY';
      
      const params = {
        symbol,
        side: slSide,
        positionSide,
        type: 'STOP', // ← LIMIT версія!
        quantity: quantity.toString(),
        price: price.toString(),
        stopPrice: price.toString(), // Trigger ціна
        timeInForce: 'GTC',
        workingType: 'CONTRACT_PRICE'
      };

      const response = await this.signedRequest('POST', '/fapi/v1/order', params);

      logger.info(`[ASTERDEX] ✅ Stop Loss LIMIT set: Order ID ${response.orderId}`);
      
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
      const response = await this.signedRequest('GET', '/fapi/v2/positionRisk', params);

      if (!Array.isArray(response)) {
        throw new Error('Invalid position response format');
      }

      // Фільтруємо тільки відкриті позиції
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
          // Визначаємо side на основі positionAmt
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

      const response = await this.signedRequest('GET', '/fapi/v1/userTrades', params);

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
    return 'BOTH'; // One-way mode
  }

  /**
   * Отримує side для ордера на основі direction
   */
  getOrderSide(direction) {
    return direction === 'LONG' ? 'BUY' : 'SELL';
  }
}

// Експортуємо singleton
const asterdexService = new AsterdexService();
export default asterdexService;
