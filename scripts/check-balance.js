import dotenv from 'dotenv';
import asterdexService from '../services/asterdex.service.js';  // ← ЗМІНЕНО
import logger from '../utils/logger.js';

dotenv.config();

async function checkBalance() {
  try {
    logger.info('Checking AsterDex balance...');  // ← ЗМІНЕНО
    
    await asterdexService.connect();  // ← ЗМІНЕНО
    const balance = await asterdexService.getUSDTBalance();  // ← ЗМІНЕНО
    
    console.log('\n' + '='.repeat(50));
    console.log(`💰 USDT Balance: ${balance.toFixed(2)} USDT`);
    console.log('='.repeat(50) + '\n');
    
    process.exit(0);
  } catch (error) {
    logger.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

checkBalance();
