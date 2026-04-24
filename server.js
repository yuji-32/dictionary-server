import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import rateLimit from "express-rate-limit";

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;
const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";

app.use(
  cors({
    origin: frontendUrl,
  })
);

app.use(express.json());

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "リクエストが多すぎます。少し待ってください。" },
});

app.use("/suggest", limiter);
app.use("/translate", limiter);
app.use("/chat", limiter);

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function extractUsedWords(message, missionWords) {
  const text = (message || "").toLowerCase();
  return missionWords.filter((word) =>
    text.includes(String(word).toLowerCase())
  );
}

app.get("/suggest", async (req, res) => {
  const query = String(req.query.q || "").trim();

  if (!query) {
    return res.json([]);
  }

  if (query.length > 100) {
    return res.status(400).json([]);
  }

  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are an English-Japanese dictionary assistant.

The user inputs an English word or phrase.

Your job:
1. Return the exact input word as the main entry.
2. Provide multiple meanings grouped by part of speech.
3. Include basic inflections if it's a verb (past, -ing, etc).
4. Optionally include 1-2 closely related expressions (NOT random synonyms).

Rules:
- Do NOT return unrelated synonyms.
- Focus on dictionary-style information.
- Keep meanings short and useful.
- Always include the original word as the first item.

Return ONLY JSON in this format:

[
  {
    "word": "study",
    "meanings": ["勉強する", "研究する"],
    "pos": ["verb", "noun"],
    "forms": ["studies", "studying", "studied"]
  },
  {
    "word": "study session",
    "meanings": ["勉強会"]
  }
]
`,
        },
        {
          role: "user",
          content: query,
        },
      ],
      temperature: 0.3,
    });

    const text = completion.choices[0].message.content || "";
    const jsonMatch = text.match(/\[.*\]/s);

    if (!jsonMatch) {
      return res.json([]);
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (error) {
      console.error("JSON parse error:", error);
      parsed = [];
    }

    return res.json(parsed);
  } catch (error) {
    console.error(error);
    return res.json([]);
  }
});

app.get("/translate", async (req, res) => {
  const text = String(req.query.text || "").trim();

  if (!text) {
    return res.json({ translated: "" });
  }

  if (text.length > 200) {
    return res.status(400).json({ translated: "" });
  }

  try {
    const response = await fetch("https://api-free.deepl.com/v2/translate", {
      method: "POST",
      headers: {
        Authorization: `DeepL-Auth-Key ${process.env.DEEPL_API_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        text,
        source_lang: "EN",
        target_lang: "JA",
      }),
    });

    const data = await response.json();
    const translated = data?.translations?.[0]?.text || "";

    return res.json({ translated });
  } catch (error) {
    console.error(error);
    return res.json({ translated: "" });
  }
});

app.post("/chat", async (req, res) => {
  try {
    const { message, missionWords = [], history = [] } = req.body;

    const safeMessage = String(message || "").trim();

    if (!safeMessage) {
      return res.status(400).json({
        error: "message is required",
      });
    }

    if (safeMessage.length > 300) {
      return res.status(400).json({
        error: "message is too long",
      });
    }

    const safeMissionWords = Array.isArray(missionWords)
      ? missionWords.filter(Boolean).slice(0, 5)
      : [];

    const recentHistory = Array.isArray(history)
      ? history.slice(-6).map((item) => ({
          role: item.role === "assistant" ? "assistant" : "user",
          english: String(item.english || "").slice(0, 300),
        }))
      : [];

    const historyText =
      recentHistory.length > 0
        ? recentHistory
            .map((item) => `${item.role.toUpperCase()}: ${item.english}`)
            .join("\n")
        : "No previous conversation.";

    const prompt = `
You are a friendly English conversation partner for a Japanese learner.

Your main job:
- Reply naturally to the user's message.
- Continue the conversation like a real conversation partner.
- Do not sound like a teacher in the english reply.

Rules:
- Keep your English short and easy to understand.
- The "english" field must contain ONLY the conversation reply.
- Do NOT mention mission words in the english field.
- Do NOT say things like "try to use these words" in the english field.
- Do NOT include correction or advice in the english field.
- Put grammar feedback only in the "correction" field.
- Put the Japanese translation of the english reply only in the "japanese" field.
- If the user's English is natural, say so briefly in Japanese in the correction field.
- If the user's English has a mistake, briefly explain the correction in Japanese.
- Do not make the reply too long.

Mission words:
${safeMissionWords.length > 0 ? safeMissionWords.join(", ") : "None"}

Recent conversation:
${historyText}

User message:
${safeMessage}

Return only valid JSON in this format:
{
  "english": "Natural conversation reply only",
  "japanese": "Japanese translation of the english reply",
  "correction": "Short grammar feedback in Japanese"
}
`;

    const response = await client.responses.create({
      model: "gpt-5.4",
      input: prompt,
    });

    const text = response.output_text?.trim();

    if (!text) {
      return res.status(500).json({
        error: "Empty response from AI",
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (jsonError) {
      console.error("JSON parse error:", jsonError, text);
      return res.status(500).json({
        error: "AI response was not valid JSON",
      });
    }

    const usedWords = extractUsedWords(safeMessage, safeMissionWords);

    return res.json({
      english: parsed.english || "Could you say that again?",
      japanese: parsed.japanese || "もう一度言ってください。",
      correction: parsed.correction || "添削を生成できませんでした。",
      usedWords,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "Failed to generate chat response",
    });
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});