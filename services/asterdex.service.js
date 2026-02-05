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
  }

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
   * ⚠️ ВИПРАВЛЕНО: Параметри НЕ сортуються, використовується порядок додавання
   */
  async createWeb3Signature(params) {
    try {
      const nonce = this.getNonce();
      
      // ✅ ВИПРАВЛЕНО: Створюємо query string БЕЗ сортування
      const paramString = Object.keys(params)
        .map(key => `${key}=${params[key]}`)
        .join('&');
      
      // Додаємо nonce, user, signer в КІНЦІ
      const finalParamString = `${paramString}&nonce=${nonce}&user=${this.userAddress}&signer=${this.signerAddress}`;
      
      logger.debug(`[ASTERDEX] Param string: ${finalParamString}`);

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
          msg: finalParamString
        }
      };

      const wallet = new ethers.Wallet(this.privateKey);
      const signature = await wallet.signTypedData(
        typedData.domain,
        { Message: typedData.types.Message },
        typedData.message
      );

      return {
        nonce,
        signature,
        paramString: finalParamString
      };
    } catch (error) {
      logger.error(`[ASTERDEX] Error creating Web3 signature: ${error.message}`);
      throw error;
    }
  }

  async signedRequest(method, endpoint, params = {}) {
    try {
      const now = Date.now();
      const timeSinceLastRequest = now - this.lastRequestTime;
      if (timeSinceLastRequest < this.minRequestInterval) {
        await new Promise(resolve => setTimeout(resolve, this.minRequestInterval - timeSinceLastRequest));
      }
      this.lastRequestTime = Date.now();

      const { nonce, signature, paramString } = await this.createWeb3Signature(params);
      
      // Формуємо фінальні параметри
      const finalParams = {
        ...params,
        nonce: nonce.toString(),
        user: this.userAddress,
        signer: this.signerAddress,
        signature
      };

      const requestConfig = {
        method,
        url: `${this.baseURL}${endpoint}`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'AsterDexBot/1.0'
        }
      };

      if (method === 'GET' || method === 'DELETE') {
        const queryString = Object.keys(finalParams)
          .map(key => `${key}=${encodeURIComponent(finalParams[key])}`)
          .join('&');
        requestConfig.url += `?${queryString}`;
      } else {
        // ✅ ВИПРАВЛЕНО: Для POST використовуємо URLSearchParams
        const formData = new URLSearchParams();
        Object.keys(finalParams).forEach(key => {
          formData.append(key, finalParams[key]);
        });
        requestConfig.data = formData.toString();
      }

      logger.debug(`[ASTERDEX] Request URL: ${requestConfig.url}`);

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

  async connect() {
    try {
      logger.info('[ASTERDEX] Connecting to AsterDex API...');
      
      await this.publicRequest('GET', '/fapi/v1/ping');
      
      const timeResponse = await this.publicRequest('GET', '/fapi/v1/time');
      const serverTime = timeResponse.serverTime;
      const localTime = Date.now();
      const timeDiff = Math.abs(serverTime - localTime);
      
      if (timeDiff > 5000) {
        logger.warn(`[ASTERDEX] Time difference with server: ${timeDiff}ms`);
      }
      
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

  // ... решта методів залишається без змін
  // (getSymbolInfo, getCurrentPrice, setLeverage, openMarketOrder, і т.д.)
}

const asterdexService = new AsterdexService();
export default asterdexService;