// Vercel serverless function: /api/simulate
// Holds the Gemini API key server-side and calls the Gemini API with
// Google Search grounding enabled, so answers can pull in real, current
// information instead of only the model's training data.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { scenario } = req.body || {};

  if (!scenario || typeof scenario !== "string" || !scenario.trim()) {
    return res.status(400).json({ error: "Missing 'scenario' in request body." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Server is missing GEMINI_API_KEY." });
  }

  const prompt = `You are a "What If" scenario simulator styled after the enthusiastic scientific voice of Senku Ishigami from Dr. Stone. Given a hypothetical scenario, use Google Search when it would make your answer more accurate or current (e.g. real statistics, recent events, specific real-world numbers), then respond with ONLY a raw JSON object — no markdown code fences, no preamble, no text outside the JSON, nothing before "{" or after "}".

The JSON must have exactly these fields:
{
  "title": "a short punchy restatement of the scenario, 6 words max",
  "explanation": "3-4 short paragraphs (separated by \\n\\n) explaining what would actually happen, grounded in real science/facts, written with confident, excited, slightly cocky scientific narration in Senku's voice",
  "plausibility": a number 0-100 for how well-established/confident the reasoning is,
  "plausibility_label": "a short 2-4 word label for that score",
  "sources": ["short label of any real source used, if search was used, otherwise empty array"]
}

Scenario: "${scenario.trim()}"`;

  try {
    const model = "gemini-2.5-flash";
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }],
            },
          ],
          tools: [{ google_search: {} }],
          generationConfig: {
            temperature: 0.9,
            maxOutputTokens: 1500,
          },
        }),
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error("Gemini API error:", geminiRes.status, errText);
      return res.status(502).json({ error: "Upstream API error", detail: errText });
    }

    const data = await geminiRes.json();

    const candidate = data.candidates && data.candidates[0];
    const text = candidate?.content?.parts?.map((p) => p.text || "").join("") || "";

    if (!text) {
      console.error("Empty response from Gemini:", JSON.stringify(data));
      return res.status(502).json({ error: "Model returned an empty response." });
    }

    let parsed;
    try {
      let clean = text.replace(/```json|```/g, "").trim();
      const firstBrace = clean.indexOf("{");
      const lastBrace = clean.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace !== -1) {
        clean = clean.slice(firstBrace, lastBrace + 1);
      }
      parsed = JSON.parse(clean);
    } catch (parseErr) {
      console.error("Failed to parse model output as JSON:", text);
      return res.status(502).json({
        error: "Model did not return valid JSON",
        raw: text,
      });
    }

    const groundingChunks = candidate?.groundingMetadata?.groundingChunks || [];
    const groundedTitles = groundingChunks
      .map((c) => c.web?.title)
      .filter(Boolean);

    if (groundedTitles.length) {
      const merged = new Set([...(parsed.sources || []), ...groundedTitles]);
      parsed.sources = Array.from(merged).slice(0, 6);
    }

    return res.status(200).json(parsed);
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
