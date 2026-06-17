require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const matchRoutes = require('./routes/matches');
const pickRoutes = require('./routes/picks');
const { startScheduler } = require('./sync');

const app = express();
const PORT = process.env.PORT || 3001;

// CORS — allow your frontend origin
app.use(cors({
  origin: [
    process.env.FRONTEND_URL,
    'http://localhost:5173',
    'http://localhost:3000',
  ],
  credentials: true
}));

app.use(express.json());

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', app: 'Bonbin PL Pick\'em' }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/matches', matchRoutes);
app.use('/api/picks', pickRoutes);

// 404 handler
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`🦁 Bonbin PL Pick'em API running on port ${PORT}`);
  startScheduler();
});
