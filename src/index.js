require('./instrumentation');

const express = require('express');
const mongoose = require('mongoose');
const { trace, metrics, context, propagation } = require('@opentelemetry/api');
const winston = require('winston');
require('dotenv').config();

const app = express();
app.use(express.json());

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  defaultMeta: { service: 'investment-service' },
  transports: [new winston.transports.Console()],
});

// MongoDB connection
mongoose.connect(process.env.MONGODB_URL || 'mongodb://localhost:27017/insurewatch');

const InvestmentSchema = new mongoose.Schema({
  customerId: String,
  portfolioId: String,
  portfolioName: String,
  totalValue: Number,
  currency: { type: String, default: 'USD' },
  holdings: [{
    symbol: String,
    name: String,
    shares: Number,
    currentPrice: Number,
    value: Number,
    changePercent: Number,
  }],
  lastUpdated: { type: Date, default: Date.now },
});
const Investment = mongoose.model('Investment', InvestmentSchema);

// OTel instruments
const meter = metrics.getMeter('investment-service', '1.0.0');
const portfolioLookups = meter.createCounter('investment.portfolio.lookups', { description: 'Portfolio lookup count' });
const portfolioValue    = meter.createHistogram('investment.portfolio.value', { description: 'Portfolio total value', unit: 'USD' });

// Chaos state
const chaosState = {
  service_crash: false,
  high_latency:  false,
  db_failure:    false,
  memory_spike:  false,
  cpu_spike:     false,
};
let memoryHog = [];

function applyChaos() {
  return new Promise((resolve, reject) => {
    if (chaosState.service_crash) return reject({ status: 503, message: 'Service unavailable (chaos: service_crash)' });
    if (chaosState.db_failure)    return reject({ status: 503, message: 'Database connection failed (chaos: db_failure)' });

    let delay = 0;
    if (chaosState.high_latency) {
      delay = 3000 + Math.random() * 5000;
      logger.warn(`Chaos: injecting ${delay.toFixed(0)}ms latency`);
    }
    if (chaosState.memory_spike) {
      logger.warn('Chaos: memory spike');
      memoryHog.push(Buffer.alloc(50 * 1024 * 1024));
    }
    if (chaosState.cpu_spike) {
      logger.warn('Chaos: CPU spike');
      const end = Date.now() + 2000;
      while (Date.now() < end) Math.sqrt(Math.random() * 1000000);
    }
    setTimeout(resolve, delay);
  });
}

// Seed data
async function seedData() {
  const existing = await Investment.findOne({}).lean();
  const count = existing ? 1 : 0;
  if (count === 0) {
    const customers = ['CUST001','CUST002','CUST003','CUST004','CUST005'];
    for (const cid of customers) {
      await Investment.create({
        customerId: cid,
        portfolioId: `PORT-${cid}`,
        portfolioName: `${cid} Growth Portfolio`,
        totalValue: 50000 + Math.random() * 200000,
        holdings: [
          { symbol: 'AAPL', name: 'Apple Inc.', shares: 50,  currentPrice: 182.5, value: 9125,  changePercent:  1.2 },
          { symbol: 'MSFT', name: 'Microsoft',  shares: 30,  currentPrice: 415.2, value: 12456, changePercent:  0.8 },
          { symbol: 'GOOGL',name: 'Alphabet',   shares: 20,  currentPrice: 171.5, value: 3430,  changePercent: -0.3 },
          { symbol: 'BRK.B',name: 'Berkshire',  shares: 100, currentPrice: 380.0, value: 38000, changePercent:  0.5 },
        ],
      });
    }
    logger.info('Seeded investment data');
  }
}

// Routes
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'investment-service', chaos: chaosState }));

app.get('/investments/:customerId', async (req, res) => {
  const tracer = trace.getTracer('investment-service');
  const span = tracer.startSpan('get_investments');
  try {
    await applyChaos();
    span.setAttribute('customer.id', req.params.customerId);

    const investment = await Investment.findOne({ customerId: req.params.customerId });
    if (!investment) return res.status(404).json({ error: 'Portfolio not found' });

    // Simulate slight price fluctuation on each request
    investment.holdings.forEach(h => {
      h.currentPrice = h.currentPrice * (1 + (Math.random() - 0.5) * 0.01);
      h.value = h.shares * h.currentPrice;
      h.changePercent = (Math.random() - 0.4) * 3;
    });
    investment.totalValue = investment.holdings.reduce((s, h) => s + h.value, 0);
    investment.lastUpdated = new Date();
    await investment.save();

    portfolioLookups.add(1, { customer_id: req.params.customerId });
    portfolioValue.record(investment.totalValue, { customer_id: req.params.customerId });
    span.setAttribute('portfolio.value', investment.totalValue);

    logger.info('Portfolio fetched', { customerId: req.params.customerId, value: investment.totalValue });
    res.json(investment);
  } catch (err) {
    span.recordException(err instanceof Error ? err : new Error(err.message));
    logger.error('Investment fetch error', { error: err.message || err });
    res.status(err.status || 500).json({ error: err.message || 'Internal error' });
  } finally {
    span.end();
  }
});

app.get('/chaos/state', (req, res) => res.json(chaosState));
app.post('/chaos/set', (req, res) => {
  Object.entries(req.body).forEach(([k, v]) => { if (k in chaosState) { chaosState[k] = v; logger.warn(`Chaos: ${k}=${v}`); } });
  if (!chaosState.memory_spike) memoryHog = [];
  res.json({ status: 'updated', chaos: chaosState });
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, async () => {
  await seedData();
  logger.info(`Investment Service started on port ${PORT}`);
});
