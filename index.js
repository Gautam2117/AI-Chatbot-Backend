const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const OpenAI = require("openai");
const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

// Load environment variables
dotenv.config();

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// DeepSeek-compatible OpenAI client
const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

// Estimate token usage (approx 1 token ≈ 4 characters)
function estimateTokenCount(text) {
  return Math.ceil(text.length / 4);
}

// Test route
app.get("/", (req, res) => {
  res.send("API is running...");
});

// Chat route
app.post("/api/chat", async (req, res) => {
  console.log("📩 /api/chat route hit!");
  const { question, faqs } = req.body;
  const userId = req.headers["x-user-id"] || "test-user";

  if (!question || !faqs || !Array.isArray(faqs)) {
    return res.status(400).json({ error: "Missing question or FAQs." });
  }

  // 🔓 Fetch user tier and set daily token limit
  let DAILY_LIMIT = 2000;
  let tier = "free";

  try {
    console.log("🔎 Fetching Firestore userId:", userId); // ✅ Log the ID
    const userDoc = await db.collection("users").doc(userId).get();

    console.log("📄 Firestore doc data:", userDoc.data()); // ✅ Log full doc

    if (userDoc.exists) {
      tier = userDoc.data().tier || "free";
    }

    if (tier === "pro") DAILY_LIMIT = 5000;
    else if (tier === "unlimited") DAILY_LIMIT = 999999;
  } catch (e) {
    console.warn("⚠️ Failed to fetch user tier, using default limit:", e.message);
  }


  const today = new Date().toDateString();
  const usageRef = db.collection("usage").doc(userId);
  let tokensUsed = 0;

  try {
    const usageSnap = await usageRef.get();
    if (!usageSnap.exists || usageSnap.data().lastReset !== today) {
      await usageRef.set({ tokensUsed: 0, lastReset: today });
    } else {
      tokensUsed = usageSnap.data().tokensUsed || 0;
    }
  } catch (err) {
    console.error("🔥 Firestore usage fetch error:", err.message);
    return res.status(500).json({ error: "Failed to fetch usage data." });
  }

  const formattedFAQ = faqs
    .map((item, index) => `${index + 1}. Q: ${item.q} A: ${item.a}`)
    .join("\n");

  const prompt = `
You are an AI customer support assistant. Use the following FAQs to answer the user's question.

FAQs:
${formattedFAQ}

User's Question: ${question}
Answer:
  `;

  const estimatedPromptTokens = estimateTokenCount(prompt);
  const estimatedOutputTokens = 100;
  const totalEstimated = estimatedPromptTokens + estimatedOutputTokens;

  if (tokensUsed + totalEstimated > DAILY_LIMIT) {
    return res.status(403).json({ error: "❌ Token limit exceeded for today. Try again tomorrow." });
  }

  try {
    const completion = await openai.chat.completions.create({
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
    });

    const reply = completion.choices[0].message.content;
    const replyTokens = estimateTokenCount(reply);
    const updatedTokens = tokensUsed + estimatedPromptTokens + replyTokens;

    await usageRef.update({ tokensUsed: updatedTokens });

    console.log("📦 Sending tier back to frontend:", tier);

    res.json({
      reply,
      tokensUsed: updatedTokens,
      dailyLimit: DAILY_LIMIT,
      tier: tier || "free", // send back user's plan
    });

  } catch (err) {
    const errorResponse = err.response?.data || err.message || err;
    console.error("❌ DeepSeek API Error:", JSON.stringify(errorResponse, null, 2));
    res.status(500).json({ error: "Failed to generate response.", debug: errorResponse });
  }
});

// Start the server
app.listen(PORT, () => console.log(`✅ Server started on port ${PORT}`));
