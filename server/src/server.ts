import express from 'express';
import { db } from './db.js';
import { createRouter } from './routes.js';

const app = express();
app.use(express.json());
app.use('/api', createRouter(db));

app.use((_req, res) => res.status(404).json({ error: 'not found' }));

const PORT = Number(process.env.PORT ?? 3001);
app.listen(PORT, () => {
  console.log(`go-ranking-analysis API listening on http://localhost:${PORT}`);
});
