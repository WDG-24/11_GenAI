import cors from 'cors';
import type { ErrorRequestHandler } from 'express';
import express from 'express';
import mongoose from 'mongoose';
import { OpenAI } from 'openai';
import { z } from 'zod';
// Hauptimporte der OpenAI Agents SDK:
// - Agent: Ein LLM mit Instructions und Tools
// - handoff: Ermöglicht die Übergabe zwischen Agents
// - run: Führt einen Agent aus
// - setDefaultOpenAIClient: Legt den OpenAI-Client global fest
// - tool: Erstellt ein Tool, das ein Agent nutzen kann
import { Agent, handoff, run, setDefaultOpenAIClient, tool } from '@openai/agents';
import type { AgentInputItem } from '@openai/agents';

// Gehört natürlich in eigene Module :)
await mongoose.connect(process.env.MONGO_URI!, { dbName: 'chat' });

// Einfaches Schema, um Chatverlauf zu speichern
type ChatMessage = AgentInputItem;

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

// ============================================================================
// OpenAI Client Setup
// ============================================================================
// Die OpenAI Klasse ist provider-agnostic und kann mit verschiedenen APIs arbeiten
// OpenAI ChatGPT
const client = new OpenAI();

// Alternativ: Google Gemini
// const client = new OpenAI({
//   apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
//   baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
// });

// Alternativ: Lokales Modell mit Ollama
// const client = new OpenAI({
//   baseURL: 'http://127.0.0.1:11434',
// });

// Setzt den OpenAI-Client als Standard für alle Agents
setDefaultOpenAIClient(client);

const port = process.env.PORT || 8080;

const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (_req, res) => {
  res.json({ message: 'Running' });
});

// ============================================================================
// Beispiel 1: Einfacher Chat-Agent mit Conversation History
// ============================================================================

// Agent-Definition: Ein LLM mit spezifischen Instructions (System Prompt)
const chatAgent = new Agent({
  name: 'Nerdy Chat Agent',
  instructions:
    'You are a Nerd. You try to steer every conversation towards Star Trek or Dungeons & Dragons. No matter what.',
  model: 'gpt-5', // Kann auch andere Modelle sein: 'gpt-4o', 'llama3.2', 'gemini-2.5-flash'
  // model: 'llama3.2',
  // model: 'gemini-2.5-flash',
  modelSettings: {
    maxTokens: 1400,
  },
});

app.post('/messages', async (req, res) => {
  const { prompt, chatId } = req.body;

  // Chat-Historie aus DB laden oder neue erstellen
  let chat: ChatDocument;
  if (!chatId) {
    chat = await Chat.create({ history: [] });
  } else {
    chat = (await Chat.findById(chatId)) as ChatDocument;
    if (!chat) throw new Error('Invalid ChatID');
  }

  // run() führt den Agent mit der Conversation History aus
  // Die neue User-Message wird zur History hinzugefügt
  const result = await run(
    chatAgent,
    chat.history.concat({ role: 'user', content: prompt }) as unknown as AgentInputItem[]
  );

  // result.history enthält den kompletten Verlauf inkl. Agent-Antworten
  chat.history = result.history;
  await chat.save();

  res.json({ result: result.finalOutput, chatId: chat._id });
});

// ============================================================================
// Beispiel 2: Agent mit Tool (Function Calling)
// ============================================================================

// tool() erstellt ein Tool, das der Agent aufrufen kann
// Tools erweitern die Fähigkeiten des Agents über reines Text-Generieren hinaus
const pokeTool = tool({
  name: 'poke_info',
  description: 'Get information about a Pokémon by name or ID', // Der Agent nutzt diese Description um zu entscheiden, wann das Tool verwendet wird
  // Zod-Schema definiert die Parameter des Tools - wird automatisch validiert
  parameters: z.object({
    pokemon: z.string().describe('The nam or the ID of a Pokémon'),
  }),
  // execute() wird aufgerufen, wenn der Agent das Tool verwendet
  async execute(input) {
    console.log('RUNNING TOOL WITH INPUT: ', input);
    const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${input.pokemon}`);
    const data = await res.json();

    // Der Return-Wert wird dem Agent als Tool-Ergebnis zurückgegeben
    return `${input.pokemon} is a Pokémon. Here is some data about it: ${JSON.stringify(data)}`;
  },
});

// Agent, der entscheidet, wann das Tool verwendet werden soll
const orchestrationAgent = new Agent({
  name: 'Pokemon Orchestrator',
  instructions: `
- You have ONE tool: pokemon_info. Use it ONLY if the user asks about a Pokémon.
- For tacos: DO NOT use any tools. Answer with exactly a 3-line haiku (5-7-5).
- For other topics: reply briefly, no tools.
- Never invent tools. Only pokemon_info exists.`,
  model: 'gpt-5',
  tools: [pokeTool], // Tools werden hier registriert - der Agent kann dann entscheiden, ob/wann er sie verwendet
});

app.post('/pokemon', async (req, res) => {
  const { prompt } = req.body;

  // run() mit einem einfachen String-Prompt (ohne History)
  const result = await run(orchestrationAgent, `Get information about: ${prompt}`);

  res.json({ result: result.finalOutput });
});

// ============================================================================
// Beispiel 3: Multi-Agent System mit Handoffs
// ============================================================================

// Spezialisierte Agents für verschiedene Aufgaben
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

// Triage Agent: Entscheidet, welcher spezialisierte Agent die Anfrage bearbeiten soll
const triageAgent = Agent.create({
  // Triage = Einstiegspunkt, der eingehende Anfragen analysiert und weiterleitet
  name: 'Triage Agent',
  instructions: `NEVER answer non-pillow related questions and stop the conversation immediately. Do not handoff, when the topic is unrelated to our pillows.
        If the question is about pillows, route it to the customer support agent. 
        If the customer's tone is negative, route it to the escalation control agent.
        `,
  model: 'gpt-5-nano',
  // handoffs: Liste von Agents, an die dieser Agent die Kontrolle übergeben kann
  // Der Agent wählt automatisch den passenden handoff basierend auf seinem Verständnis der Anfrage
  handoffs: [
    customerSupportAgent,
    // handoff() mit zusätzlicher Konfiguration:
    // - inputType: Validiert die Daten bei der Übergabe
    // - onHandoff: Callback-Funktion, die beim Handoff ausgeführt wird
    handoff(escalationControlAgent, {
      // Wenn bei der Übergabe an einen anderen Agent zusätzliche Aktionen nötig sind:
      // z.B. Logs, E-Mail-Benachrichtigungen, Datenbankabfragen, Metriken etc.
      inputType: z.object({ reason: z.string() }),
      onHandoff: async (ctx, input) => {
        console.log({ ctx });
        console.log(`Handoff to Escalation Control Agent: ${input?.reason}`);
        // Hier könnten z.B. Benachrichtigungen an Manager gesendet werden
      },
    }),
  ],
  // outputGuardrails: []
  // Guardrails sind optionale Sicherheitschecks:
  // - Input Guardrails: Prüfen User-Eingaben (z.B. auf unangemessene Inhalte)
  // - Output Guardrails: Validieren KI-Antworten (z.B. Format, Richtigkeit)
  // Wenn ein Guardrail fehlschlägt, kann die gesamte Anfrage wiederholt oder abgebrochen werden
});

app.post('/pillow-support', async (req, res) => {
  const { prompt } = req.body;

  // Der triageAgent analysiert die Anfrage und gibt ggf. an einen spezialisierten Agent weiter
  // Die Handoff-Logik ist transparent - das System wählt automatisch den besten Agent
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
