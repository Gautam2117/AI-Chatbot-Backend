const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const OpenAI = require("openai");
const admin = require("firebase-admin");
const Razorpay = require("razorpay");
const crypto = require("crypto");
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

// Test Endpoint
app.get("/", (req, res) => {
  res.send("✅ AI Chatbot + Razorpay API running...");
});

// Razorpay: Create Order (Updated with error logging)
app.post("/api/create-order", async (req, res) => {
  const { amount, currency = "INR", receipt = `receipt_${Date.now()}`, userId, plan } = req.body;
  const options = {
    amount: amount * 100, // Convert ₹ to paise
    currency,
    receipt,
    notes: { userId, plan },
  };
  try {
    const order = await razorpay.orders.create(options);
    res.json({
      orderId: order.id,
      currency: order.currency,
      amount: order.amount,
    });
  } catch (err) {
    console.error("❌ Razorpay order error:", err.message, err);
    res.status(500).json({ error: err.message || "Failed to create Razorpay order" });
  }
});

// Razorpay Webhook (Updated Signature Handling)
app.post("/api/razorpay-webhook", express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const generatedSignature = crypto.createHmac('sha256', secret).update(req.body).digest('hex');

  if (generatedSignature !== signature) {
    console.warn("❌ Invalid webhook signature");
    return res.status(400).send("Invalid signature");
  }

  let event;
  try {
    event = JSON.parse(req.body);
  } catch (e) {
    console.error("❌ Error parsing webhook payload:", e);
    return res.status(400).send("Invalid payload");
  }

  console.log(`📢 Webhook Event: ${event.event}`);

  // Handle payment.captured for plan upgrades
  if (event.event === "payment.captured") {
    const payment = event.payload.payment.entity;
    const notes = payment.notes || {};
    const userId = notes.userId;
    const plan = notes.plan;
    if (userId && plan) {
      try {
        await db.collection("users").doc(userId).update({ tier: plan });
        console.log(`✅ Webhook: Upgraded ${userId} to ${plan}`);
      } catch (err) {
        console.error("🔥 Firestore upgrade error:", err.message);
      }
    }
  }

  // Handle optional events
  else if (event.event === "payment.failed") {
    console.warn("⚠️ Payment failed for payment_id:", event.payload.payment.entity.id);
  } else if (event.event === "order.paid") {
    console.log("💸 Order paid:", event.payload.order.entity.id);
  } else if (event.event === "refund.processed") {
    console.log("💸 Refund processed for:", event.payload.refund.entity.id);
  } else if (event.event === "invoice.paid") {
    console.log("🧾 Invoice paid:", event.payload.invoice.entity.id);
  }

  res.json({ received: true });
});

// 🔥 Old: Upgrade Tier via Frontend (Optional for Testing)
app.post("/api/upgrade-tier", async (req, res) => {
  const { userId, plan } = req.body;
  if (!userId || !plan) {
    return res.status(400).json({ error: "Missing userId or plan" });
  }
  try {
    await db.collection("users").doc(userId).update({ tier: plan });
    res.json({ success: true, message: `Tier updated to ${plan}` });
  } catch (err) {
    console.error("❌ Firestore upgrade error:", err.message);
    res.status(500).json({ error: "Failed to upgrade tier" });
  }
});

// Chat Endpoint
app.post("/api/chat", async (req, res) => {
  console.log("📩 /api/chat route hit!");

  const { question } = req.body;
  const userId = req.headers["x-user-id"] || "test-user";

  if (!question) {
    return res.status(400).json({ error: "Missing question." });
  }

  let DAILY_LIMIT = 2000;
  let tier = "free";

  // Fetch user's tier (free, pro, unlimited)
  try {
    const userDoc = await db.collection("users").doc(userId).get();
    if (userDoc.exists) tier = userDoc.data().tier || "free";
    if (tier === "pro") DAILY_LIMIT = 5000;
    else if (tier === "unlimited") DAILY_LIMIT = 999999;
  } catch (err) {
    console.warn("⚠️ Tier fetch failed:", err.message);
  }

  // Fetch user's FAQs from subcollection /faqs/{userId}/list
  let faqs = [];
  try {
    const faqSnapshot = await db.collection("faqs").doc(userId).collection("list").get();
    faqs = faqSnapshot.docs.map(doc => doc.data());
  } catch (err) {
    console.error("❌ Failed to fetch FAQs for user:", userId, err.message);
  }

  // Prepare the prompt
  let prompt;
  if (faqs.length > 0) {
    const formattedFAQ = faqs.map((item, index) => `${index + 1}. Q: ${item.q} A: ${item.a}`).join("\n");
    prompt = `You are an AI customer support assistant. Use the following FAQs to answer the user's question.\n\nFAQs:\n${formattedFAQ}\n\nUser's Question: ${question}\nAnswer:\n`;
  } else {
    prompt = `You are an AI customer support assistant. Answer the following question without any FAQs.\n\nUser's Question: ${question}\nAnswer:\n`;
  }

  const estimatedPromptTokens = estimateTokenCount(prompt);
  const estimatedOutputTokens = 100;
  const totalEstimated = estimatedPromptTokens + estimatedOutputTokens;

  // Usage tracking
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
      await usageRef.set({ tokensUsed: 0, lastReset: Timestamp.now() });
      tokensUsed = 0;
    } else {
      tokensUsed = usageData?.tokensUsed || 0;
    }
  } catch (err) {
    console.error("🔥 Usage fetch error:", err.message);
    return res.status(500).json({ error: "Failed to fetch usage data." });
  }

  if (tokensUsed + totalEstimated > DAILY_LIMIT) {
    await db.collection("users").doc(userId).update({ tier: "free" });
    return res.status(403).json({ error: "❌ Token limit exceeded. You are downgraded to Free Plan. Upgrade to continue." });
  }

  // Generate AI response
  try {
    const completion = await openai.chat.completions.create({
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
    });
    const reply = completion.choices[0].message.content;
    const replyTokens = estimateTokenCount(reply);
    const updatedTokens = tokensUsed + estimatedPromptTokens + replyTokens;
    await usageRef.update({ tokensUsed: updatedTokens });
    res.json({ reply, tokensUsed: updatedTokens, dailyLimit: DAILY_LIMIT, tier: tier || "free" });
  } catch (err) {
    const errorResponse = err.response?.data || err.message || err;
    console.error("❌ DeepSeek API Error:", JSON.stringify(errorResponse, null, 2));
    res.status(500).json({ error: "Failed to generate response.", debug: errorResponse });
  }
});

// Razorpay Payment Verification API
app.post("/api/verify-payment", async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ success: false, message: "Missing payment details." });
  }

  const secret = process.env.RAZORPAY_SECRET;

  // Generate the expected signature
  const generatedSignature = crypto
    .createHmac("sha256", secret)
    .update(razorpay_order_id + "|" + razorpay_payment_id)
    .digest("hex");

  if (generatedSignature === razorpay_signature) {
    console.log("✅ Payment verification successful for order:", razorpay_order_id);
    res.json({ success: true, message: "Payment verified successfully." });
  } else {
    console.warn("❌ Payment verification failed for order:", razorpay_order_id);
    res.status(400).json({ success: false, message: "Invalid signature." });
  }
});

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
