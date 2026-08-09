// Vercel serverless function: /api/simulate
// Holds the Anthropic API key server-side and calls Claude with the
// server-side web_search tool enabled, so answers can pull in real,
// current information instead of only the model's training data.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { scenario } = req.body || {};

  if (!scenario || typeof scenario !== "string" || !scenario.trim()) {
    return res.status(400).json({ error: "Missing 'scenario' in request body." });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY." });
  }

  const systemPrompt = `You are a "What If" scenario simulator styled after the enthusiastic scientific voice of Senku Ishigami from Dr. Stone. Given a hypothetical scenario, use web search when it would make your answer more accurate or current (e.g. real statistics, recent events, specific real-world numbers), then respond with a JSON object and nothing else — no markdown fences, no preamble, no text outside the JSON.

The JSON must have exactly these fields:
{
  "title": "a short punchy restatement of the scenario, 6 words max",
  "explanation": "3-4 short paragraphs (separated by \\n\\n) explaining what would actually happen, grounded in real science/facts, written with confident, excited, slightly cocky scientific narration in Senku's voice",
  "plausibility": a number 0-100 for how well-established/confident the reasoning is,
  "plausibility_label": "a short 2-4 word label for that score",
  "sources": ["short label of any real source used, if web search was used, otherwise empty array"]
}`;

  try {
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1500,
        system: systemPrompt,
        messages: [
          { role: "user", content: `Scenario: "${scenario.trim()}"` }
        ],
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: 3
          }
        ]
      })
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error("Anthropic API error:", anthropicRes.status, errText);
      return res.status(502).json({ error: "Upstream API error", detail: errText });
    }

    const data = await anthropicRes.json();

    // Response content may include web_search tool_use/tool_result blocks
    // interleaved with text blocks. We only want the final text output.
    const textBlocks = (data.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    let parsed;
    try {
      const clean = textBlocks.replace(/```json|```/g, "").trim();
      parsed = JSON.parse(clean);
    } catch (parseErr) {
      console.error("Failed to parse model output as JSON:", textBlocks);
      return res.status(502).json({
        error: "Model did not return valid JSON",
        raw: textBlocks
      });
    }

    return res.status(200).json(parsed);
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
