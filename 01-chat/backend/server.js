import cors from 'cors';
import express from 'express';
import { OpenAI } from 'openai';
import { z } from 'zod';
import { zodResponseFormat } from 'openai/helpers/zod';
import mongoose from 'mongoose';

await mongoose.connect(process.env.MONGO_URI, { dbName: 'chat' });

const Chat = mongoose.model(
  'chat',
  new mongoose.Schema({
    history: {
      type: [Object],
      default: [],
    },
  })
);

const ai = new OpenAI({
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
});

// const ai = new OpenAI({
//   apiKey: 'ollama',
//   baseURL: 'http://127.0.0.1:11434/v1',
// });

const port = process.env.PORT || 8080;

const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (_req, res) => {
  res.json({ message: 'Running' });
});

app.post('/messages', async (req, res) => {
  const { prompt, chatId } = req.body;

  let chat;
  if (!chatId) {
    chat = await Chat.create({
      history: [{ role: 'system', content: 'You are Gollum, from The Lord of the Rings. Always answer in character.' }],
    });
  } else {
    chat = await Chat.findById(chatId);
  }

  const result = await ai.chat.completions.create({
    model: 'gemini-2.5-flash',
    messages: [...chat.history, { role: 'user', content: prompt }],
  });

  chat.history = [...chat.history, { role: 'user', content: prompt }, result.choices[0].message];
  await chat.save();

  res.json({ result: result.choices[0].message, chatId: chat._id });
});

app.use('/{*splat}', () => {
  throw Error('Page not found', { cause: { status: 404 } });
});

app.use((err, _req, res, _next) => {
  console.log(err);
  res.status(err.cause?.status || 500).json({ message: err.message });
});

app.listen(port, () => console.log(`AI Proxy listening on port ${port}`));
