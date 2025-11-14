import cors from 'cors';
import type { ErrorRequestHandler } from 'express';
import express from 'express';
import mongoose from 'mongoose';
import { OpenAI } from 'openai';
import { z } from 'zod';
import { Agent, handoff, run, setDefaultOpenAIClient, tool } from '@openai/agents';

// Gehört natürlich in eigene Module :)
await mongoose.connect(process.env.MONGO_URI!, { dbName: 'chat' });

// Einfaches Schema, um Chatverlauf zu speichern
type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessage;

interface ChatDocument extends mongoose.Document {
  history: ChatMessage[];
}

const chatSchema = new mongoose.Schema<ChatDocument>({
  history: {
    type: [Object],
    default: [],
  },
});

const Chat = mongoose.model<ChatDocument>('chat', chatSchema);

// OpenAI Klasse ermöglicht client für die Verbindung mit verschiedensten AI-Providern
// Google Gemini
// const client = new OpenAI({
//   apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
//   baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
// });

// OpenAI ChatGPT
const client = new OpenAI();

// Lokales Modell mit Ollama
// const client = new OpenAI({
//   baseURL: 'http://127.0.0.1:11434',
// });

setDefaultOpenAIClient(client);

const port = process.env.PORT || 8080;

const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (_req, res) => {
  res.json({ message: 'Running' });
});

const chatAgent = new Agent({
  name: 'Nerdy Chat Agent',
  instructions:
    'You are a Nerd. You try to steer every conversation towards Star Trek or Dungeons & Dragons. No matter what.',
  model: 'gpt-5',
  // model: 'llama3.2',
  // model: 'gemini-2.5-flash',
  modelSettings: {
    maxTokens: 1400,
  },
});

app.post('/messages', async (req, res) => {
  const { prompt, chatId } = req.body;

  let chat: ChatDocument;
  if (!chatId) {
    chat = await Chat.create({ history: [] });
  } else {
    chat = (await Chat.findById(chatId)) as ChatDocument;
    if (!chat) throw new Error('Invalid ChatID');
  }
  const result = await run(chatAgent, chat.history.concat({ role: 'user', content: prompt }));

  chat.history = result.history;
  await chat.save();

  res.json({ result: result.finalOutput, chatId: chat._id });
});

const pokeTool = tool({
  name: 'poke_info',
  description: 'Get information about a Pokémon by name or ID',
  parameters: z.object({
    pokemon: z.string().describe('The nam or the ID of a Pokémon'),
  }),
  async execute(input) {
    console.log('RUNNING TOOL WITH INPUT: ', input);
    const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${input.pokemon}`);
    const data = await res.json();

    return `${input.pokemon} is a Pokémon. Here is some data about it: ${JSON.stringify(data)}`;
  },
});

const orchestrationAgent = new Agent({
  name: 'Pokemon Orchestrator',
  instructions: `
- You have ONE tool: pokemon_info. Use it ONLY if the user asks about a Pokémon.
- For tacos: DO NOT use any tools. Answer with exactly a 3-line haiku (5-7-5).
- For other topics: reply briefly, no tools.
- Never invent tools. Only pokemon_info exists.`,
  model: 'gpt-5',
  tools: [pokeTool],
});

app.post('/pokemon', async (req, res) => {
  const { prompt } = req.body;

  const result = await run(orchestrationAgent, `Get information about: ${prompt}`);

  res.json({ result: result.finalOutput });
});

const customerSupportAgent = new Agent({
  name: 'Customer Support Agent',
  instructions: `You are a customer support agent in a company that sells very fluffy pillows. Be friendly, helpful. and concise.`,
  model: 'gpt-5',
  // model: 'gemini-2.5-flash',
});

const escalationControlAgent = new Agent({
  name: 'Escalation Control Agent',
  instructions: `You are an escalation control agent that handles negative customer interactions. 
            If the customer is upset, you will apologize and offer to escalate the issue to a manager.
            Be friendly, helpful, reassuring and concise.`,
  model: 'gpt-4o',
});

const triageAgent = Agent.create({
  // dieser Agent entscheidet, welcher Agent die Anfrage weiter behandeln soll
  name: 'Triage Agent',
  instructions: `NEVER answer non-pillow related questions and stop the conversation immediately. Do not handoff, when the topic is unrelated to our pillows.
        If the question is about pillows, route it to the customer support agent. 
        If the customer's tone is negative, route it to the escalation control agent.
        `,
  model: 'gpt-5-nano',
  handoffs: [
    customerSupportAgent,
    handoff(escalationControlAgent, {
      // wenn bei der Übargabe an einen anderen Agenten weitere Dinge geschehen sollen
      // z.B. Logs, eMail-Benachrichtigungen, Datenbankabfragen, etc.
      inputType: z.object({ reason: z.string() }),
      onHandoff: async (ctx, input) => {
        console.log({ ctx });
        console.log(`Handoff to Escalation Control Agent: ${input?.reason}`);
      },
    }),
  ],
  // outputGuardrails: [], // Guardrails checken Input (user) oder Output (KI)
  // Wenn z.B. ein Output nicht den gewünschten Kriterien entspricht, kann z.B. die gesamte Anfrage wiederholt werden.
});

app.post('/pillow-support', async (req, res) => {
  const { prompt } = req.body;

  const result = await run(triageAgent, prompt);

  res.json({ result: result.finalOutput });
});

app.use('/{*splat}', () => {
  throw Error('Page not found', { cause: { status: 404 } });
});

app.use(((err, _req, res, _next) => {
  console.log(err);
  res.status(err.cause?.status || 500).json({ message: err.message });
}) satisfies ErrorRequestHandler);

app.listen(port, () => console.log(`AI Proxy with OpenAI Agents SDK listening on port ${port}`));
