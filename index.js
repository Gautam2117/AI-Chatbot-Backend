const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const OpenAI = require("openai");
const admin = require("firebase-admin");
const Razorpay = require("razorpay");
const { Timestamp } = require("firebase-admin").firestore;
const serviceAccount = require("./serviceAccountKey.json");

dotenv.config();

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Razorpay Setup
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || "rzp_test_dummy",
  key_secret: process.env.RAZORPAY_SECRET || "test_dummy_secret",
});


// DeepSeek Setup
const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

function estimateTokenCount(text) {
  return Math.ceil(text.length / 4);
}

// Test
app.get("/", (req, res) => {
  res.send("✅ AI Chatbot + Razorpay API running...");
});

// Razorpay: Create Order
app.post("/api/create-order", async (req, res) => {
  const { amount, currency = "INR", receipt = `receipt_${Date.now()}` } = req.body;

  const options = {
    amount: amount * 100, // ₹100 => 10000 paise
    currency,
    receipt,
  };

  try {
    const order = await razorpay.orders.create(options);
    res.json({
      orderId: order.id,
      currency: order.currency,
      amount: order.amount,
    });
  } catch (err) {
    console.error("❌ Razorpay order error:", err.message);
    res.status(500).json({ error: "Failed to create Razorpay order" });
  }
});

// Chat
app.post("/api/chat", async (req, res) => {
  console.log("📩 /api/chat route hit!");
  const { question, faqs } = req.body;
  const userId = req.headers["x-user-id"] || "test-user";

  if (!question || !faqs || !Array.isArray(faqs)) {
    return res.status(400).json({ error: "Missing question or FAQs." });
  }

  let DAILY_LIMIT = 2000;
  let tier = "free";

  try {
    const userDoc = await db.collection("users").doc(userId).get();
    if (userDoc.exists) {
      tier = userDoc.data().tier || "free";
    }

    if (tier === "pro") DAILY_LIMIT = 5000;
    else if (tier === "unlimited") DAILY_LIMIT = 999999;
  } catch (e) {
    console.warn("⚠️ Tier fetch failed:", e.message);
  }

  const today = new Date().toDateString();
  const usageRef = db.collection("usage").doc(userId);
  let tokensUsed = 0;

  try {
    const usageSnap = await usageRef.get();
    let usageData = null;
    let resetToday = true;

    if (usageSnap.exists) {
      usageData = usageSnap.data();
      const lastReset = usageData.lastReset?.toDate().toDateString?.();
      resetToday = lastReset !== today;
    }

    if (resetToday) {
      await usageRef.set({
        tokensUsed: 0,
        lastReset: Timestamp.now(),
      });
      tokensUsed = 0;
    } else {
      tokensUsed = usageData?.tokensUsed || 0;
    }
  } catch (err) {
    console.error("🔥 Usage fetch error:", err.message);
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

    res.json({
      reply,
      tokensUsed: updatedTokens,
      dailyLimit: DAILY_LIMIT,
      tier: tier || "free",
    });
  } catch (err) {
    const errorResponse = err.response?.data || err.message || err;
    console.error("❌ DeepSeek API Error:", JSON.stringify(errorResponse, null, 2));
    res.status(500).json({ error: "Failed to generate response.", debug: errorResponse });
  }
});

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
