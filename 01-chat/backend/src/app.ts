import cors from 'cors';
import type { ErrorRequestHandler } from 'express';
import express from 'express';

import mongoose from 'mongoose';

await mongoose.connect(process.env.MONGO_URI!, { dbName: 'chat' });

const port = process.env.PORT || 8080;

const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (_req, res) => {
  res.json({ message: 'Running' });
});

app.use('/{*splat}', () => {
  throw Error('Page not found', { cause: { status: 404 } });
});

app.use(((err, _req, res, _next) => {
  console.log(err);
  res.status(err.cause?.status || 500).json({ message: err.message });
}) satisfies ErrorRequestHandler);

app.listen(port, () => console.log(`AI Proxy listening on port ${port}`));
