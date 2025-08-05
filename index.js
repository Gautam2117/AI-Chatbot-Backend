// server.js (complete)

import "./dailyReset.js";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import Razorpay from "razorpay";
import crypto from "crypto";
import { Timestamp, FieldValue } from "firebase-admin/firestore";
import { db } from "./firebase.js";
import stringSimilarity from "string-similarity";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// If you're behind a proxy (Render/Heroku/NGINX), so req.ip works properly
app.set("trust proxy", 1);

// --- CORS ---
app.use(
  cors({
    origin: true, // Reflect the request origin
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "x-user-id"],
    credentials: true,
  })
);

/**
 * IMPORTANT: Razorpay webhook needs raw body for signature verification.
 * Register the webhook route BEFORE express.json().
 */

// Razorpay Webhook (Fixed Signature & Payload Handling)
app.post(
  "/api/razorpay-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["x-razorpay-signature"];
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

    if (!signature || !secret) {
      console.warn("❌ Missing Razorpay signature or secret");
      return res.status(400).send("Missing signature or secret");
    }

    let rawBody;
    try {
      rawBody = req.body.toString("utf8"); // Convert buffer to string
    } catch (err) {
      console.error("❌ Failed to parse raw body:", err.message);
      return res.status(400).send("Invalid raw body");
    }

    // Signature validation
    const generatedSignature = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

    if (generatedSignature !== signature) {
      console.warn("❌ Invalid Razorpay webhook signature");
      return res.status(400).send("Invalid signature");
    }

    let event;
    try {
      event = JSON.parse(rawBody);
    } catch (err) {
      console.error("❌ JSON parse error:", err.message);
      return res.status(400).send("Invalid JSON payload");
    }

    const eventId = event?.payload?.payment?.entity?.id || event?.event;
    if (!eventId) return res.status(400).send("❌ Invalid webhook: missing event ID");

    // 🧠 Deduplication
    const logRef = db.collection("webhookLogs").doc(eventId);
    const existing = await logRef.get();
    if (existing.exists) {
      console.log(`ℹ️ Webhook ${eventId} already processed`);
      return res.status(200).send("✅ Webhook already processed");
    }

    console.log(`📢 Razorpay Webhook Received: ${event.event}`);

    // ✅ Handle subscription upgrade on payment capture
    if (event.event === "payment.captured") {
      const payment = event.payload.payment.entity;
      const notes = payment.notes || {};
      const userId = notes.userId;
      const plan = notes.plan;

      if (userId && plan) {
        try {
          const userSnap = await db.collection("users").doc(userId).get();
          const userData = userSnap.data();

          if (!userData?.companyId) {
            throw new Error("Company ID not found for user");
          }

          const companyId = userData.companyId;
          const now = Timestamp.now();

          await db
            .collection("companies")
            .doc(companyId)
            .set(
              {
                tier: plan,
                tokensUsedToday: 0,
                lastReset: now,
                subscriptionExpiresAt: Timestamp.fromDate(
                  new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days
                ),
              },
              { merge: true }
            );

          console.log(`✅ Upgraded company ${companyId} to '${plan}'`);
        } catch (err) {
          console.error("🔥 Firestore upgrade error:", err.message);
        }
      } else {
        console.warn("⚠️ Missing userId or plan in payment notes");
      }
    } else if (event.event === "payment.failed") {
      console.warn("⚠️ Payment failed:", event.payload?.payment?.entity?.id);
    } else if (event.event === "order.paid") {
      console.log("💸 Order paid:", event.payload?.order?.entity?.id);
    } else if (event.event === "refund.processed") {
      console.log("💸 Refund processed:", event.payload?.refund?.entity?.id);
    } else if (event.event === "invoice.paid") {
      console.log("🧾 Invoice paid:", event.payload?.invoice?.entity?.id);
    }

    // ✅ Log for audit trail
    await logRef.set({
      timestamp: Timestamp.now(),
      type: event.event,
      raw: event,
    });

    res.status(200).send("✅ Webhook processed");
  }
);

// After webhook is wired, JSON parser is safe to use for the rest
app.use(express.json({ limit: "1mb" }));

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

// Razorpay: Create Order
const PLAN_PRICING = {
  pro: 14900,
  pro_max: 39900,
};

app.post("/api/create-order", async (req, res) => {
  const { plan, userId, companyId } = req.body;

  // 1. Validate plan
  if (!PLAN_PRICING[plan]) {
    return res.status(400).json({ error: "Invalid plan selected." });
  }

  // 2. Prepare order details
  const amount = PLAN_PRICING[plan];
  const currency = "INR";
  const shortId = (companyId || userId || "anon").slice(0, 10);
  const receipt = `botify_${shortId}_${Date.now().toString().slice(-6)}`; // ~28–35 chars

  const options = {
    amount, // in paise
    currency,
    receipt,
    notes: { userId, companyId, plan },
  };

  try {
    const order = await razorpay.orders.create(options);
    res.status(200).json({
      orderId: order.id,
      currency: order.currency,
      amount: order.amount,
    });
  } catch (err) {
    console.error("❌ Razorpay order error:", err.message, err);
    res.status(500).json({
      error: err.message || "Failed to create Razorpay order",
    });
  }
});

/* ================================
   FAQs Endpoint for the Widget
   GET /api/faqs?userId=... OR ?companyId=...
   Returns: [{ question, answer }, ...]
================================= */

async function getCompanyIdForUser(userId) {
  const userSnap = await db.collection("users").doc(userId).get();
  if (!userSnap.exists) throw Object.assign(new Error("User not found"), { code: 404 });
  const userData = userSnap.data();
  if (!userData?.companyId)
    throw Object.assign(new Error("User has no company linked"), { code: 404 });
  return userData.companyId;
}

function normalizeFaqDoc(d) {
  const q = (d.q ?? d.question ?? d.title ?? "").toString().trim();
  const a = (d.a ?? d.answer ?? "").toString().trim();
  if (!q || !a) return null;
  return { question: q, answer: a };
}

// tiny in-memory rate limit: 120 req/min per IP (for this route only)
const hits = new Map();
app.use("/api/faqs", (req, res, next) => {
  const ip =
    req.ip ||
    req.headers["x-forwarded-for"] ||
    req.connection?.remoteAddress ||
    "unknown";
  const now = Date.now();
  const cur = hits.get(ip) || { count: 0, resetAt: now + 60_000 };
  if (now > cur.resetAt) {
    cur.count = 0;
    cur.resetAt = now + 60_000;
  }
  cur.count += 1;
  hits.set(ip, cur);
  if (cur.count > 120) return res.status(429).json({ error: "Too many requests" });
  next();
});

app.get("/api/faqs", async (req, res) => {
  try {
    const qUserId = (req.query.userId || req.headers["x-user-id"] || "").toString();
    const qCompanyId = (req.query.companyId || "").toString();
    const companyId = qCompanyId || (qUserId ? await getCompanyIdForUser(qUserId) : null);
    if (!companyId) return res.status(400).json({ error: "Missing userId/companyId" });

    // (Optional: orderBy("updatedAt","desc")) if you store timestamps
    const snap = await db.collection("faqs").doc(companyId).collection("list").limit(200).get();

    const faqs = snap.docs.map((doc) => normalizeFaqDoc(doc.data())).filter(Boolean);

    // ETag + Conditional GET
    const etag = crypto.createHash("sha1").update(JSON.stringify(faqs)).digest("hex");
    if (req.headers["if-none-match"] === etag) {
      return res.status(304).end();
    }

    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=120");
    return res.json(faqs);
  } catch (err) {
    const code = err?.code === 404 ? 404 : 500;
    return res.status(code).json({ error: err.message || "Failed to fetch FAQs" });
  }
});

/* ================================
   Manual upgrade (dev only)
================================= */

app.post("/api/upgrade-tier", async (req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(403).json({ error: "Manual upgrade disabled in production." });
  }

  const { userId, plan } = req.body;
  if (!userId || !plan) {
    return res.status(400).json({ error: "Missing userId or plan" });
  }

  try {
    const userSnap = await db.collection("users").doc(userId).get();
    const userData = userSnap.data();
    const companyId = userData?.companyId;

    if (!companyId) {
      return res.status(400).json({ error: "User has no company linked" });
    }

    const now = Timestamp.now();
    const oneMonthLater = Timestamp.fromDate(
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    ); // 30 days

    await db
      .collection("companies")
      .doc(companyId)
      .set(
        {
          tier: plan,
          tokensUsedToday: 0,
          lastReset: now,
          subscriptionExpiresAt: oneMonthLater,
        },
        { merge: true }
      );

    res.json({ success: true, message: `Tier upgraded to ${plan}` });
  } catch (err) {
    console.error("🔥 Error upgrading tier:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/* ================================
   CHAT with company token limits
================================= */

app.post("/api/chat", async (req, res) => {
  console.log("📩 /api/chat route hit!");

  // 60s safeguard timeout for hung clients
  res.setTimeout(60000, () => {
    try {
      res.write("\n[Error: timeout]");
      res.end();
    } catch {
      res.end();
    }
  });

  const { question } = req.body;
  const userId = req.headers["x-user-id"] || "test-user";

  const userQuestion =
    typeof question === "string" ? question.trim() : "";
  if (!userQuestion) {
    return res.status(400).json({ error: "Missing or invalid question." });
  }
  if (userQuestion.length > 2000) {
    return res.status(400).json({ error: "Question too long." });
  }

  // 🔐 Firestore references
  const userRef = db.collection("users").doc(userId);
  const userDoc = await userRef.get();
  if (!userDoc.exists) return res.status(404).json({ error: "User not found." });

  const userData = userDoc.data();
  const companyId = userData.companyId;
  if (!companyId) return res.status(400).json({ error: "User not linked to a company." });

  const companyRef = db.collection("companies").doc(companyId);
  const companyDoc = await companyRef.get();
  if (!companyDoc.exists) return res.status(404).json({ error: "Company not found." });

  const companyData = companyDoc.data();
  const subscriptionExpiresAt = companyData?.subscriptionExpiresAt?.toDate?.();

  // 🛠️ Downgrade if expired + update local companyData
  if (subscriptionExpiresAt && subscriptionExpiresAt < new Date()) {
    await companyRef.update({
      tier: "free",
      subscriptionExpiresAt: null,
    });
    companyData.tier = "free";
  }

  // 📊 Tier & token limits
  let { tier = "free", tokensUsedToday = 0, lastReset } = companyData;
  const tierLimits = { free: 1000, pro: 10000, pro_max: 66000 };
  const monthlyCaps = { free: 30000, pro: 300000, pro_max: 2000000 };
  const monthlyCap = monthlyCaps[tier] ?? 30000;
  const tokensUsedMonth = companyData?.tokensUsedMonth || 0;

  const dailyLimit = tierLimits[tier] ?? 1000;

  const today = new Date().toDateString();
  const lastResetDate = lastReset?.toDate?.()?.toDateString?.();

  if (!lastReset || lastResetDate !== today) {
    await companyRef.update({
      tokensUsedToday: 0,
      lastReset: Timestamp.now(),
    });
    tokensUsedToday = 0;
  }

  if (tokensUsedToday >= dailyLimit) {
    return res.status(403).json({
      error: "❌ Company token limit exceeded. Please upgrade to continue.",
    });
  }

  // 📋 Load and sanitize FAQs (prefer client-provided to save a DB read)
  let faqs = Array.isArray(req.body.faqs) ? req.body.faqs : [];
  try {
    if (!faqs.length) {
      const faqSnap = await db
        .collection("faqs")
        .doc(companyId)
        .collection("list")
        .get();
      faqs = faqSnap.docs.map((doc) => doc.data());
    }

    faqs = faqs
      .map((f) => ({
        q: (f.q ?? f.question ?? f.title ?? "").toString().trim(),
        a: (f.a ?? f.answer ?? "").toString().trim(),
      }))
      .filter((f) => f.q && f.a);
  } catch (err) {
    console.warn("⚠️ FAQ fetch failed:", err.message);
  }

  function normalize(str) {
    return str?.trim().toLowerCase().replace(/[^\w\s]/gi, "").replace(/\s+/g, " ");
  }

  // ✅ 1. Exact Match
  const exactMatch = faqs.find((f) => normalize(f.q) === normalize(userQuestion));
  if (exactMatch) {
    const reply = exactMatch.a;
    const replyTokens = estimateTokenCount(reply);
    await companyRef.update({ tokensUsedToday: FieldValue.increment(replyTokens) });
    res.setHeader("Content-Type", "text/plain");
    res.write(reply);
    return res.end();
  }

  // ✅ 2. Fuzzy Match — SAFE version
  try {
    const cleanedMatches = faqs
      .map((f) => (typeof f.q === "string" ? f.q.trim() : null))
      .filter((q) => typeof q === "string" && q.length > 0);

    if (cleanedMatches.length > 0) {
      const { bestMatch, bestMatchIndex } = stringSimilarity.findBestMatch(
        userQuestion,
        cleanedMatches
      );

      if (bestMatch?.rating > 0.9) {
        const reply = faqs[bestMatchIndex]?.a || "";
        const replyTokens = estimateTokenCount(reply);
        await companyRef.update({ tokensUsedToday: FieldValue.increment(replyTokens) });

        res.setHeader("Content-Type", "text/plain");
        res.write(reply);
        return res.end();
      }
    }
  } catch (e) {
    console.warn("❌ Fuzzy matching failed safely:", e.message);
  }

  // 🤖 3. DeepSeek Fallback
  const formattedFAQ = faqs
    .slice(0, 5)
    .map((f, i) => `${i + 1}. Q: ${f.q}\nA: ${f.a}`)
    .join("\n");

  const prompt = faqs.length
    ? `You are an AI customer support assistant. Use the following FAQs to help answer the user's question:\n\n${formattedFAQ}\n\nUser: ${userQuestion}\nAnswer:`
    : `You are an AI customer support assistant. Answer the following question:\n\n${userQuestion}\nAnswer:`;

  const estimatedPromptTokens = estimateTokenCount(prompt);
  const estimatedOutputTokens = 100;
  const totalEstimated = estimatedPromptTokens + estimatedOutputTokens;

  if (tokensUsedToday + totalEstimated > dailyLimit) {
    return res.status(403).json({
      error: "❌ Company token limit exceeded. Please upgrade to continue.",
    });
  }

  if (tokensUsedMonth + totalEstimated > monthlyCap) {
    return res.status(403).json({
      error: "❌ Monthly token cap reached. Please wait for renewal or upgrade.",
    });
  }

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Transfer-Encoding", "chunked");
  res.setHeader("Cache-Control", "no-cache");

  let replyText = "";

  try {
    const completion = await openai.chat.completions.create({
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
      stream: true,
    });

    for await (const chunk of completion) {
      const delta = chunk?.choices?.[0]?.delta?.content || "";
      if (delta) {
        replyText += delta;
        res.write(delta);
      }
    }
  } catch (err) {
    console.error("❌ Streaming error:", err);
    res.write("\n[Error: generation failed]");
  } finally {
    try {
      await db.runTransaction(async (transaction) => {
        const docSnap = await transaction.get(companyRef);
        const company = docSnap.data();
        const lastResetDate2 = company?.lastReset?.toDate()?.toDateString?.();
        const today2 = new Date().toDateString();

        const replyTokens = estimateTokenCount(replyText);
        const totalTokensToAdd = estimatedPromptTokens + replyTokens;

        if (!lastResetDate2 || lastResetDate2 !== today2) {
          transaction.update(companyRef, {
            tokensUsedToday: totalTokensToAdd,
            tokensUsedMonth: FieldValue.increment(totalTokensToAdd),
            lastReset: Timestamp.now(),
          });
        } else {
          transaction.update(companyRef, {
            tokensUsedToday: FieldValue.increment(totalTokensToAdd),
            tokensUsedMonth: FieldValue.increment(totalTokensToAdd),
          });
        }
      });
    } catch (e) {
      console.warn("⚠️ Token update failed:", e.message);
    }

    res.end();
  }
});

/* ================================
   Razorpay Payment Verification
================================= */

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

/* ================================
   Company registration
================================= */

app.post("/api/register-company", async (req, res) => {
  const { userId, companyName } = req.body;
  if (!userId || !companyName) return res.status(400).json({ error: "Missing fields." });

  try {
    const companyDoc = await db.collection("companies").add({
      name: companyName,
      tier: "free",
      createdAt: Timestamp.now(),
    });

    await db.collection("users").doc(userId).update({
      companyId: companyDoc.id,
    });

    res.json({ message: "Company registered & user linked.", companyId: companyDoc.id });
  } catch (err) {
    console.error("❌ Company registration error:", err.message);
    res.status(500).json({ error: "Failed to register company." });
  }
});

/* ================================
   Usage status (for widget)
================================= */

app.get("/api/usage-status", async (req, res) => {
  const userId = req.headers["x-user-id"];
  if (!userId) return res.status(400).json({ error: "Missing userId" });

  // 🔐 Fetch user and company
  const userSnap = await db.collection("users").doc(userId).get();
  const userData = userSnap.data();
  const companyId = userData?.companyId;

  if (!companyId) {
    return res.status(404).json({ error: "User has no company linked" });
  }

  const companyRef = db.collection("companies").doc(companyId);
  const companySnap = await companyRef.get();
  const companyData = companySnap.data();

  if (!companyData) {
    return res.status(404).json({ error: "Company not found" });
  }

  // ⏳ Subscription expiry logic
  const subscriptionExpiresAtRaw = companyData?.subscriptionExpiresAt;
  const subscriptionExpiresAt = subscriptionExpiresAtRaw?.toDate?.();
  let { tier = "free", tokensUsedToday = 0, lastReset } = companyData;

  if (subscriptionExpiresAt && subscriptionExpiresAt < new Date()) {
    await companyRef.update({
      tier: "free",
      subscriptionExpiresAt: null,
    });
    tier = "free";
  }

  const tierLimits = { free: 1000, pro: 10000, pro_max: 66000 };
  const dailyLimit = tierLimits[tier] ?? 1000;

  // 🔄 Reset if new day
  const today = new Date().toDateString();
  const lastResetDate = lastReset?.toDate?.()?.toDateString?.();

  // (Keep dailyReset.js as the main reset, this is just a safety)
  if (!lastReset || lastResetDate !== today) {
    console.log("⚠️ Resetting tokens due to date mismatch:", lastResetDate, today);
    await companyRef.update({
      tokensUsedToday: 0,
      lastReset: Timestamp.now(),
    });
    return res.json({
      usage: 0,
      limit: dailyLimit,
      blocked: false,
      subscriptionExpiresAt: tier === "free" ? null : subscriptionExpiresAtRaw,
    });
  }

  const blocked = tokensUsedToday >= dailyLimit;

  return res.json({
    usage: tokensUsedToday,
    limit: dailyLimit,
    blocked,
    subscriptionExpiresAt: tier === "free" ? null : subscriptionExpiresAtRaw,
  });
});

/* ================================
   Start server
================================= */

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
