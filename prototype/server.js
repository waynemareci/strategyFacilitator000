import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

function formatTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit',
    hour12: true, timeZoneName: 'short',
    timeZone: 'America/New_York',
  }).formatToParts(date);
  const get = (type) => parts.find(p => p.type === type)?.value ?? '';
  return `${get('weekday')} ${get('month')} ${get('day')} ${get('hour')}:${get('minute')}:${get('second')} ${get('dayPeriod')} ${get('timeZoneName')}`;
}

// Load system prompt
const systemPrompt = readFileSync(
  join(__dirname, '../prompts/system-prompt-v1.txt'),
  'utf-8'
);

// Load welcome message — strip developer header and trailing separator
let WELCOME_MESSAGE;
try {
  const raw = readFileSync(join(__dirname, '../prompts/welcome.txt'), 'utf-8');
  const afterHeader = raw.includes('\n---\n') ? raw.split('\n---\n').slice(1).join('\n---\n') : raw;
  WELCOME_MESSAGE = afterHeader.replace(/\n-{3,}\s*$/, '').trim();
} catch (err) {
  console.error('FATAL: Could not load prompts/welcome.txt:', err.message);
  process.exit(1);
}

// GET /welcome — returns the welcome message for display in the UI
app.get('/welcome', (_req, res) => {
  res.json({ message: WELCOME_MESSAGE });
});

// Extract a person's name from a natural language string using Claude Haiku.
// Returns the extracted name, or the string "UNKNOWN" if no name can be identified.
async function extractName(rawInput) {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 64,
    system: `You extract a person's name from a natural language string.
Return ONLY the name — first name, or full name if provided.
Do not include any punctuation, explanation, or surrounding text.
If no name can be identified, return exactly the word UNKNOWN and nothing else.`,
    messages: [{ role: 'user', content: rawInput }],
  });
  const result = response.content[0].text.trim();
  console.log(`[extractName] input: "${rawInput}" → "${result}"`);
  return result;
}

// POST /register-name — register a user's name and assign a unique identifier
// Body: { sessionId: string, rawInput: string }
// Returns: { userIdentifier: string }  e.g. "Sarah0042"
// Returns 400 with { error } if no name can be extracted from rawInput
app.post('/register-name', async (req, res) => {
  const { sessionId, rawInput } = req.body;

  if (!rawInput || !rawInput.trim()) {
    return res.status(400).json({ error: 'rawInput is required' });
  }

  let displayName;
  try {
    const extracted = await extractName(rawInput.trim());
    if (extracted === 'UNKNOWN') {
      return res.status(400).json({
        error: "Could not identify a name from your response. Please try again.",
      });
    }
    displayName = extracted;
  } catch (err) {
    console.error('extractName error:', err.message);
    return res.status(500).json({ error: 'Failed to process name' });
  }

  const firstName = displayName.split(/\s+/)[0];

  try {
    // Atomically increment counter via Supabase RPC
    const { data: counterData, error: counterError } = await supabase.rpc('increment_user_counter');
    if (counterError) throw counterError;

    const paddedNum = String(counterData).padStart(4, '0');
    const userIdentifier = `${firstName}${paddedNum}`;

    // Store user record
    const { error: insertError } = await supabase.from('users').insert([{
      user_identifier: userIdentifier,
      display_name: displayName,
      session_id: sessionId,
    }]);
    if (insertError) throw insertError;

    console.log(`[Register] ${userIdentifier} (session ${sessionId})`);
    res.json({ userIdentifier });
  } catch (err) {
    console.error('register-name error:', err.message);
    res.status(500).json({ error: 'Failed to register name' });
  }
});

// POST /chat endpoint
// Body: { sessionId: string, messages: [{role, content}], userIdentifier?: string }
// Returns: { reply: string }
app.post('/chat', async (req, res) => {
  const { sessionId = crypto.randomUUID(), messages, userIdentifier } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  const userMessage = messages[messages.length - 1].content;

  // Personalize system prompt with first name if available
  let activePrompt = systemPrompt;
  if (userIdentifier) {
    const firstName = userIdentifier.replace(/\d+$/, '');
    activePrompt = `${systemPrompt}\n\nThe user's name is ${firstName}. Address them by name occasionally in a natural, friendly way.`;
  }

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-5-20251101',
      max_tokens: 1024,
      system: activePrompt,
      messages,
    });

    const reply = response.content[0].text;

    // Log to Supabase — fire and forget
    const ts = formatTimestamp();
    supabase.from('conversation_logs').insert([
      { session_id: sessionId, role: 'user',      content: userMessage, timestamp_display: ts },
      { session_id: sessionId, role: 'assistant', content: reply,       timestamp_display: ts },
    ]).then(({ error }) => {
      if (error) console.error('Supabase log error:', error.message);
    });

    const label = userIdentifier ?? sessionId;
    console.log(`[${label}] Turn ${Math.ceil(messages.length / 2)}`);

    res.json({ reply });
  } catch (err) {
    console.error('Claude API error:', err.message);
    res.status(500).json({ error: 'Failed to get response from Claude' });
  }
});

// GET /admin/sessions — summarize all logged sessions from Supabase
app.get('/admin/sessions', async (_req, res) => {
  const [logsResult, usersResult] = await Promise.all([
    supabase.from('conversation_logs').select('session_id, id, timestamp_display').neq('content', '__START__').order('id', { ascending: true }),
    supabase.from('users').select('session_id, user_identifier'),
  ]);

  if (logsResult.error) return res.status(500).json({ error: logsResult.error.message });
  if (usersResult.error) return res.status(500).json({ error: usersResult.error.message });

  // Map session_id → user_identifier for quick lookup
  const userMap = new Map(usersResult.data.map(u => [u.session_id, u.user_identifier]));

  const sessionMap = new Map();
  for (const row of logsResult.data) {
    const { session_id, id, timestamp_display } = row;
    if (!sessionMap.has(session_id)) {
      sessionMap.set(session_id, { sessionId: session_id, messageCount: 0, lastId: id, lastActivity: timestamp_display });
    }
    const s = sessionMap.get(session_id);
    s.messageCount += 1;
    if (id > s.lastId) {
      s.lastId = id;
      s.lastActivity = timestamp_display;
    }
  }

  res.json([...sessionMap.values()]
    .sort((a, b) => b.lastId - a.lastId)
    .map(({ sessionId, messageCount, lastActivity }) => ({
      sessionId,
      userIdentifier: userMap.get(sessionId) || null,
      messageCount,
      lastActivity,
    })));
});

// GET /admin/transcript/:sessionId — full conversation for one session
app.get('/admin/transcript/:sessionId', async (req, res) => {
  const { sessionId } = req.params;

  const { data, error } = await supabase
    .from('conversation_logs')
    .select('id, role, content, timestamp_display')
    .eq('session_id', sessionId)
    .order('id', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  res.json(data);
});

// Export the app for Vercel's serverless runtime.
// Vercel imports this module and handles HTTP — app.listen() is not called there.
export default app;

// Local development only — Vercel sets VERCEL=1 in its environment.
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Goal discovery prototype running at http://localhost:${PORT}`);
  });
}