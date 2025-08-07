// server.js (autopay + yearly + message quotas)

import "./dailyReset.js";
import rateLimit from "express-rate-limit";
import helmet from "helmet"
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import Razorpay from "razorpay";
import crypto from "crypto";
import { Timestamp, FieldValue } from "firebase-admin/firestore";
import { db } from "./firebase.js";
import stringSimilarity from "string-similarity";
import basicAuth from "express-basic-auth";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
app.set("trust proxy", 1);

/* =========================
   CORS
========================= */
app.use(
  cors({
    origin: true,
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "x-user-id"],
    credentials: true,
  })
);

app.use(helmet());

/* =========================
   Razorpay client
========================= */
const keyId     = process.env.RAZORPAY_KEY_ID;
const keySecret = process.env.RAZORPAY_SECRET;

if (!keyId || !keySecret) {
  throw new Error(
    "Razorpay keys not found in environment. Refusing to start."
  );
}

const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });

/* =========================
   OpenAI / DeepSeek
========================= */
if (!process.env.DEEPSEEK_API_KEY) throw new Error("Missing DEEPSEEK_API_KEY");
if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_SECRET)
  throw new Error("Missing Razorpay keys");

const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});

/* =========================
   Plans (INR, paise)
   - You can pre-create plans in Razorpay and put IDs in .env
   - If an ID is missing, server will create a plan on demand (and cache it in memory)
========================= */
const PLAN_CATALOG = {
  // Pro — 3,000 msgs / month
  pro_monthly: {
    tier: "pro",
    period: "monthly",
    interval: 1,
    amountPaise: 649900, // ₹6,499.00
    name: "Botify Pro (3,000 msgs) — Monthly",
    envKey: "RP_PLAN_PRO_MONTHLY",
  },
  pro_yearly: {
    tier: "pro",
    period: "yearly",
    interval: 1,
    // 2 months free => 10x monthly price
    amountPaise: 649900 * 10, // ₹64,990.00
    name: "Botify Pro (3,000 msgs) — Yearly",
    envKey: "RP_PLAN_PRO_YEARLY",
  },

  // Pro Max — 15,000 msgs / month
  promax_monthly: {
    tier: "pro_max",
    period: "monthly",
    interval: 1,
    amountPaise: 1999900, // ₹19,999.00
    name: "Botify Pro Max (15,000 msgs) — Monthly",
    envKey: "RP_PLAN_PROMAX_MONTHLY",
  },
  promax_yearly: {
    tier: "pro_max",
    period: "yearly",
    interval: 1,
    amountPaise: 1999900 * 10, // ₹199,990.00
    name: "Botify Pro Max (15,000 msgs) — Yearly",
    envKey: "RP_PLAN_PROMAX_YEARLY",
  },

  // Overage add-on (per 1k msgs) — used as subscription addon
  overage_1k: {
    name: "Overage 1,000 messages",
    amountPaise: 65000, // ₹650
  },
};

// Message quotas per month (free is hard-capped)
const MESSAGE_LIMITS = {
  free: 150,
  pro: 3000,
  pro_max: 15000,
  scale: Number.POSITIVE_INFINITY,
};

// util to approximate tokens (kept only for logging/back-compat)
function estimateTokenCount(text) {
  return Math.ceil((text || "").length / 4);
}

/* ---------- INTERNAL Cron ---------- */

app.post(
  "/internal/overage-run",
  basicAuth({
    users: { [process.env.CRON_USER]: process.env.CRON_PASS },
    challenge: true,
  }),
  async (_req, res) => {
    try {
      await nightlyOverageJob();
      return res.json({ ok: true });
    } catch (e) {
      console.error("Overage CRON error", e);
      return res.status(500).json({ error: e.message });
    }
  }
);

async function nightlyOverageJob() {
  const snaps = await db.collection("companies").where("subscriptionId", "!=", null).get();
  for (const doc of snaps.docs) {
    const c = doc.data();
    const limit   = MESSAGE_LIMITS[c.tier] ?? 0;
    const used    = c.messagesUsedMonth || 0;
    const over    = Math.max(0, used - limit);
    const blocks  = Math.floor(over / 1000);      // charge in 1 k chunks
    if (blocks === 0 || c.isOverageBilled) continue;

    try {
      await razorpay.subscriptions.addAddon(c.subscriptionId, {
        item: {
          name: `Overage ${blocks * 1000} messages`,
          amount: PLAN_CATALOG.overage_1k.amountPaise * blocks,
          currency: "INR",
        },
        quantity: 1,
      });
      await doc.ref.update({ isOverageBilled: true });
      console.log(`💸 Overage billed: ${doc.id} +${blocks}k`);
    } catch (e) {
      console.error("Failed to add overage addon", e);
    }
  }
}

/* ===========================================================
   Razorpay Webhook — MUST run before express.json()
   We verify signature and then handle subscription lifecycle.
=========================================================== */
// ──────────────────────────────────────────────────────────────
//  Razorpay Webhook ‒ do business logic *before* marking logged
// ──────────────────────────────────────────────────────────────
app.post(
  "/api/razorpay-webhook",
  express.raw({ type: "application/json" }),        // keep raw-body for signature check
  async (req, res) => {
    const signature = req.headers["x-razorpay-signature"];
    const secret    = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!signature || !secret) return res.status(400).send("Missing signature or secret");

    /* ---------- verify HMAC ---------- */
    let rawBody;
    try { rawBody = req.body.toString("utf8"); }
    catch { return res.status(400).send("Invalid raw body"); }

    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    const validSig = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    if (!validSig) {
      console.warn("❌ Invalid Razorpay webhook signature");
      return res.status(400).send("Invalid signature");
    }

    /* ---------- parse event ---------- */
    let event;
    try { event = JSON.parse(rawBody); }
    catch { return res.status(400).send("Invalid JSON"); }

    const evtType  = event?.event;
    const dedupKey =
      event?.payload?.subscription?.entity?.id ||
      event?.payload?.invoice?.entity?.id      ||
      event?.payload?.payment?.entity?.id      ||
      `${evtType}:${event?.created_at || Date.now()}`;

    const logRef = db.collection("webhookLogs").doc(dedupKey);
    const existingLog = await logRef.get();
    if (existingLog.exists && existingLog.data()?.processed)
      return res.status(200).send("Already processed");

    /* ------------------------------------------------------------------ */
    try {
      /* ======= 1.  MAIN BUSINESS LOGIC (unchanged) ======= */

      /* --- subscription.* events --- */
      if (evtType?.startsWith("subscription.")) {
        const sub   = event?.payload?.subscription?.entity;
        if (!sub) throw new Error("Missing subscription entity");

        const notes        = sub.notes || {};
        const userId       = notes.userId;
        const companyIdRaw = notes.companyId;
        const planKey      = notes.planKey;

        const targetCompanyId =
          companyIdRaw || (await getCompanyIdForUser(userId).catch(() => null));

        if (targetCompanyId) {
          const ref   = db.collection("companies").doc(targetCompanyId);
          const data  = {
            subscriptionId:     sub.id,
            subscriptionStatus: sub.status,                 // active / paused / ...
            tier:               PLAN_CATALOG[planKey]?.tier || "pro",
            billingInterval:    planKey?.includes("yearly") ? "yearly" : "monthly",
            currentPeriodEnd:   sub.current_end
              ? Timestamp.fromDate(new Date(sub.current_end * 1000))
              : null,
            messagesUsedMonth: 0,
            lastMsgAt:         Timestamp.now(),
          };
          await ref.set(data, { merge: true });
          console.log(`✅ Company ${targetCompanyId} -> ${data.tier} [${sub.status}]`);
        } else {
          console.warn("Webhook: unable to resolve company for", sub.id);
        }
      }

      /* --- invoice.paid --- */
      else if (evtType === "invoice.paid") {
        const inv   = event?.payload?.invoice?.entity;
        const subId = inv?.subscription_id;
        if (subId) {
          const companies = await db
            .collection("companies")
            .where("subscriptionId", "==", subId)
            .limit(1)
            .get();

          if (!companies.empty) {
            const ref = companies.docs[0].ref;

            let currentEndTs = null;
            try {
              const s = await razorpay.subscriptions.fetch(subId);
              if (s?.current_end) currentEndTs = Timestamp.fromDate(new Date(s.current_end * 1000));
            } catch {/* ignore – best-effort */}

            await ref.set(
              {
                messagesUsedMonth: 0,
                currentPeriodEnd:  currentEndTs || FieldValue.delete(),
                subscriptionStatus:"active",
                isOverageBilled:   false,
              },
              { merge: true }
            );
            console.log(`🧾 invoice.paid → reset month for ${ref.id}`);
          }
        }
      }

      /* --- payment.failed --- */
      else if (evtType === "payment.failed") {
        const pay   = event?.payload?.payment?.entity;
        const subId = pay?.subscription_id;
        if (subId) {
          const companies = await db
            .collection("companies")
            .where("subscriptionId", "==", subId)
            .limit(1)
            .get();

          if (!companies.empty) {
            await companies.docs[0].ref.set(
              { subscriptionStatus: "past_due" },
              { merge: true }
            );
            console.warn(`⚠️ payment.failed → ${companies.docs[0].id} marked past_due`);
          }
        }
      }

      /* ======= 2. mark log as processed ======= */
      await logRef.set({ ts: Timestamp.now(), evtType, raw: event, processed: true });
    } catch (e) {
      console.error("Webhook handler error:", e);

      // store failure for manual retry ‒ *without* blocking Razorpay retries
      await logRef.set({
        ts: Timestamp.now(),
        evtType,
        raw: event,
        error: e.message || "unknown",
        processed: false,
      });

      // still HTTP-200 to avoid duplicate automatic retries – we track retry need via processed:false
    }

    return res.status(200).send("ok");
  }
);

// After webhook route:
app.use(express.json({ limit: "1mb" }));

/* =========================
   Helpers
========================= */
async function getCompanyIdForUser(userId) {
  const s = await db.collection("users").doc(userId).get();
  if (!s.exists) throw Object.assign(new Error("User not found"), { code: 404 });
  const d = s.data();
  if (!d?.companyId)
    throw Object.assign(new Error("User has no company linked"), { code: 404 });
  return d.companyId;
}

// In-memory created plan cache (for when env IDs are missing)
const planCache = new Map();

async function getOrCreateRazorpayPlan(planKey) {
  const cfg = PLAN_CATALOG[planKey];
  if (!cfg) throw Object.assign(new Error("Unknown planKey"), { code: 400 });

  // Env override
  const envId = process.env[cfg.envKey];
  if (envId) return envId;

  if (planCache.has(planKey)) return planCache.get(planKey);

  // Create a plan on the fly (visible in Razorpay dashboard)
  const period = cfg.period === "yearly" ? "year" : "month";
  const plan = await razorpay.plans.create({
    period, // "month" | "year"
    interval: cfg.interval,
    item: {
      name: cfg.name,
      amount: cfg.amountPaise,
      currency: "INR",
      description:
        cfg.tier === "pro"
          ? "Up to 3,000 messages / month"
          : "Up to 15,000 messages / month",
    },
    notes: { planKey },
  });

  planCache.set(planKey, plan.id);
  console.log(`🆕 Created Razorpay plan ${planKey} -> ${plan.id}`);
  return plan.id;
}

/* =========================
   Public: status & ping
========================= */
app.get("/", (req, res) => {
  res.send("✅ Botify backend running (autopay + yearly enabled).");
});

/* Billing catalogue for frontend */
const toRs = (paise) => Math.round(paise / 100); // 649900 → 6499

app.get("/api/billing/plans", (_req, res) => {
  res.json({
    currency: "INR",
    pro: {
      monthly: {
        price: toRs(PLAN_CATALOG.pro_monthly.amountPaise),
        messages: 3000,
        planKey: "pro_monthly",
      },
      yearly: {
        price: toRs(PLAN_CATALOG.pro_yearly.amountPaise),
        messages: 3000,
        planKey: "pro_yearly",
      },
    },
    proMax: {
      monthly: {
        price: toRs(PLAN_CATALOG.promax_monthly.amountPaise),
        messages: 15000,
        planKey: "promax_monthly",
      },
      yearly: {
        price: toRs(PLAN_CATALOG.promax_yearly.amountPaise),
        messages: 15000,
        planKey: "promax_yearly",
      },
    },
    overage: { per_1k: toRs(PLAN_CATALOG.overage_1k.amountPaise) },
  });
});

/* ===========================================================
   Billing: create a subscription (autopay)
   Frontend opens Razorpay Checkout with subscription_id
=========================================================== */
app.post("/api/billing/subscribe", async (req, res) => {
  try {
    const { planKey, userId, companyId, customer } = req.body;
    if (!planKey) return res.status(400).json({ error: "Missing planKey" });
    const planId = await getOrCreateRazorpayPlan(planKey);

    const targetCompanyId =
      companyId || (userId ? await getCompanyIdForUser(userId) : null);
    if (!targetCompanyId) return res.status(400).json({ error: "Missing companyId" });

    // Create (or reuse) a Razorpay customer (optional but nice for invoices)
    let customerId = null;
    if (customer?.email) {
      try {
        const c = await razorpay.customers.create({
          name: customer.name || "Botify User",
          email: customer.email,
          contact: customer.contact || undefined,
          notes: { companyId: targetCompanyId, userId: userId || "" },
        });
        customerId = c.id;
      } catch {
        // ignore — customer is optional
      }
    }

    // NOTE: total_count — if omitted/0, Razorpay treats it as "auto-renew till cancelled".
    const sub = await razorpay.subscriptions.create({
      plan_id: planId,
      total_count: 0, // continue indefinitely
      customer_notify: 1,
      customer_id: customerId || undefined,
      notes: { planKey, companyId: targetCompanyId, userId: userId || "" },
      // charge_at: undefined // immediate
    });

    // Store subscription shell immediately
    await db.collection("companies").doc(targetCompanyId).set(
      {
        subscriptionId: sub.id,
        subscriptionStatus: sub.status,
        tier: PLAN_CATALOG[planKey].tier,
        billingInterval: planKey.includes("yearly") ? "yearly" : "monthly",
        currentPeriodEnd: sub.current_end
          ? Timestamp.fromDate(new Date(sub.current_end * 1000))
          : null,
      },
      { merge: true }
    );

    res.json({
      subscriptionId: sub.id,
      shortKey: planKey,
      status: sub.status,
      // Razorpay Checkout options you might want on the FE:
      checkout: {
        key: process.env.RAZORPAY_KEY_ID,
        subscription_id: sub.id,
        customer_id: customerId,
        name: "Botify",
        description: PLAN_CATALOG[planKey].name,
        notes: { planKey, companyId: targetCompanyId },
      },
    });
  } catch (e) {
    console.error("subscribe error", e);
    res.status(500).json({ error: e.message || "Failed to create subscription" });
  }
});

/* ===========================================================
   One-click add-on: 1 000 extra messages
=========================================================== */
app.post("/api/billing/buy-overage", async (req, res) => {
  const { userId, blocks = 1 } = req.body;           // blocks → 1 k chunks
  if (!userId)           return res.status(400).json({ error: "Missing userId" });
  if (blocks < 1 || blocks > 20)
    return res.status(400).json({ error: "Invalid blocks" });

  try {
    const companyId = await getCompanyIdForUser(userId);
    const snap      = await db.collection("companies").doc(companyId).get();
    const subId     = snap.data()?.subscriptionId;
    if (!subId) return res.status(400).json({ error: "No active subscription" });

    const addon = await razorpay.subscriptions.addAddon(subId, {
      item: {
        name: `Pre-paid ${blocks * 1000} messages`,
        amount: PLAN_CATALOG.overage_1k.amountPaise * blocks,
        currency: "INR",
      },
      quantity: 1,
    });

    await snap.ref.update({ isOverageBilled: true });
    return res.json({ ok: true, addonId: addon.id });
  } catch (e) {
    console.error("buy-overage error", e);
    return res.status(500).json({ error: e.message });
  }
});

/* ===========================================================
   (Optional) Switch plan (creates a new subscription & cancels old at period end)
=========================================================== */
app.post("/api/billing/switch", async (req, res) => {
  try {
    const { planKey, companyId } = req.body;
    if (!planKey || !companyId)
      return res.status(400).json({ error: "Missing planKey/companyId" });

    const doc = await db.collection("companies").doc(companyId).get();
    const existing = doc.data();
    if (existing?.subscriptionId) {
      try {
        await razorpay.subscriptions.cancel(existing.subscriptionId, { cancel_at_cycle_end: 1 });
      } catch (e) {
        console.warn("cancel old sub failed (ignore):", e?.error?.description || e.message);
      }
    }

    // reuse /subscribe flow
    req.body.userId = null;
    return app._router.handle(req, res, require("finalhandler")(req, res));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* ===========================================================
   (Optional) Cancel now
=========================================================== */
app.post("/api/billing/cancel", async (req, res) => {
  const { companyId } = req.body;
  if (!companyId) return res.status(400).json({ error: "Missing companyId" });
  const snap = await db.collection("companies").doc(companyId).get();
  const subId = snap.data()?.subscriptionId;
  if (!subId) return res.status(400).json({ error: "No subscription" });

  try {
    await razorpay.subscriptions.cancel(subId);
    await snap.ref.set({ subscriptionStatus: "cancelled" }, { merge: true });
    res.json({ cancelled: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ===========================================================
   FAQs for Widget (unchanged except minor safety)
=========================================================== */
const hits = new Map();
app.use("/api/faqs", (req, res, next) => {
  const ip =
    req.ip || req.headers["x-forwarded-for"] || req.connection?.remoteAddress || "unknown";
  const now = Date.now();
  const cur = hits.get(ip) || { count: 0, resetAt: now + 60_000 };
  if (now > cur.resetAt) Object.assign(cur, { count: 0, resetAt: now + 60_000 });
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

    const snap = await db.collection("faqs").doc(companyId).collection("list").limit(200).get();
    const faqs = snap.docs
      .map((d) => {
        const x = d.data();
        const q = (x.q ?? x.question ?? x.title ?? "").toString().trim();
        const a = (x.a ?? x.answer ?? "").toString().trim();
        return q && a ? { question: q, answer: a } : null;
      })
      .filter(Boolean);

    const etag = crypto.createHash("sha1").update(JSON.stringify(faqs)).digest("hex");
    if (req.headers["if-none-match"] === etag) return res.status(304).end();

    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=120");
    return res.json(faqs);
  } catch (e) {
    return res.status(500).json({ error: e.message || "Failed to fetch FAQs" });
  }
});

/* ===========================================================
   CHAT — now gated by **messages/month**
   (tokens kept for logging/back-compat only)
=========================================================== */
app.use(
  "/api/chat",
  rateLimit({
    windowMs: 15 * 60 * 1000, // 15 min
    max: 200,                 // 200 chats / IP / window
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// ──────────────────────────────────────────────────────────────
//  POST  /api/chat           (CONCURRENCY-SAFE VERSION)
// ──────────────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  console.log("📩 /api/chat");

  /* ---------- time-box the whole request to 60 s ---------- */
  res.setTimeout(60_000, () => {
    try { res.write("\n[Error: timeout]"); } finally { res.end(); }
  });

  /* ---------- validate input ---------- */
  const userId   = req.headers["x-user-id"] || "test-user";
  const qRaw     = typeof req.body.question === "string" ? req.body.question.trim() : "";
  if (!qRaw)       return res.status(400).json({ error: "Missing or invalid question." });
  if (qRaw.length > 2_000)
    return res.status(400).json({ error: "Question too long (2 000 chars max)." });
  if (qRaw.split(/\s+/).length < 4)
    return res.status(400).json({ error: "Please ask a more specific question (≥ 4 words)." });

  /* ---------- fetch user & company ---------- */
  const userDoc = await db.collection("users").doc(userId).get();
  if (!userDoc.exists)               return res.status(404).json({ error: "User not found." });
  const companyId = userDoc.data()?.companyId;
  if (!companyId)
    return res.status(400).json({ error: "User not linked to a company." });

  const companyRef = db.collection("companies").doc(companyId);
  const companyDoc = await companyRef.get();
  if (!companyDoc.exists)            return res.status(404).json({ error: "Company not found." });

  /* ---------- quota — check & reserve atomically ---------- */
  const reserveResult = await db.runTransaction(async (tx) => {
    const snap = await tx.get(companyRef);
    const c    = snap.data() || {};

    // soft-downgrade if subscription is paused / halted
    const tierRaw = c.tier || "free";
    const tier    =
      ["halted", "paused"].includes(c.subscriptionStatus) ? "free" : tierRaw;

    const monthlyLimit = MESSAGE_LIMITS[tier] ?? 150;
    let   used         = c.messagesUsedMonth || 0;

    // reset counter if billing cycle ended
    const end   = c.currentPeriodEnd?.toDate?.();
    const cycleReset = end && new Date() > end;
    if (cycleReset) used = 0;

    if (used >= monthlyLimit) return { allowed: false };       // hard stop

    tx.update(companyRef, {
      messagesUsedMonth: used + 1,          // **reserve one slot now**
      lastMsgAt:         Timestamp.now(),
      ...(cycleReset && { currentPeriodEnd: null, messagesUsedMonth: 1 }),
    });
    return { allowed: true, tier, monthlyLimit };
  });

  if (!reserveResult.allowed) {
    return res
      .status(403)
      .json({ error: "Monthly message limit reached. Please upgrade to continue." });
  }

  /* ---------- fetch FAQs (cached by caller if provided) ---------- */
  let faqs = Array.isArray(req.body.faqs) ? req.body.faqs : [];
  try {
    if (!faqs.length) {
      const snap = await db
        .collection("faqs")
        .doc(companyId)
        .collection("list")
        .get();
      faqs = snap.docs.map((d) => d.data());
    }
    faqs = faqs
      .map((f) => ({
        q: (f.q ?? f.question ?? f.title ?? "").toString().trim(),
        a: (f.a ?? f.answer  ?? "").toString().trim(),
      }))
      .filter((f) => f.q && f.a);
  } catch (e) {
    console.warn("FAQ fetch failed:", e.message);
  }

  const normalize = (s) =>
    s.trim().toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ");

  /* ---------- exact FAQ match ---------- */
  const exact = faqs.find((f) => normalize(f.q) === normalize(qRaw));
  if (exact) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.write(exact.a);
    return res.end();
  }

  /* ---------- fuzzy FAQ match ---------- */
  try {
    const qs = faqs.map((f) => f.q);
    if (qs.length) {
      const { bestMatch, bestMatchIndex } = stringSimilarity.findBestMatch(qRaw, qs);
      if (bestMatch?.rating > 0.9) {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.write(faqs[bestMatchIndex].a);
        return res.end();
      }
    }
  } catch (e) {
    console.warn("Fuzzy match failed:", e.message);
  }

  /* ---------- LLM fallback ---------- */
  const faqPrefix = faqs
    .slice(0, 5)
    .map((f, i) => `${i + 1}. Q: ${f.q}\n   A: ${f.a}`)
    .join("\n");

  const prompt =
    (faqs.length
      ? `You are an AI customer-support assistant.\nUse these FAQs if helpful:\n${faqPrefix}\n\n`
      : "You are an AI customer-support assistant.\n\n") +
    `User: ${qRaw}\nAnswer (concise):`;

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Transfer-Encoding", "chunked");
  res.setHeader("Cache-Control", "no-cache");

  let replyText = "";
  const promptTokens = estimateTokenCount(prompt); // legacy metric

  try {
    /* ──────────────── 1. Call DeepSeek in streaming mode ──────────────── */
    const stream = await openai.chat.completions.create({
      model:    "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
      stream:   true,
    });

    /* ──────────────── 2. Proxy chunks to the client ──────────────── */
    for await (const chunk of stream) {
      const delta = chunk?.choices?.[0]?.delta?.content || "";
      if (delta) {
        replyText += delta;       // assemble full assistant reply
        res.write(delta);         // stream to browser
      }
    }
  } catch (e) {
    /* Any network / model error -> emit marker so FE can react */
    console.error("Streaming error:", e);
    res.write("\n[Error: generation failed]");
  } finally {
    /* ──────────────── 3. Telemetry (optional) ────────────────
      • Message quota was already *reserved* at txn-start, so
        we DO NOT touch `messagesUsedMonth` again here.
      • We can still log an *approx* token cost for analytics.
    ---------------------------------------------------------------- */
    const approxTokens =
      promptTokens +                       // prompt that we sent
      estimateTokenCount(replyText);       // assistant response size

    db.collection("companies")
      .doc(companyId)
      .update({
        /* purely legacy stats – safe to drop any time */
        tokensUsedMonthLegacy: FieldValue.increment(approxTokens),
      })
      .catch((err) =>
        console.warn("Legacy token telemetry failed:", err.message)
      );

    /* done – flush the response */
    res.end();
  }

});


/* ===========================================================
   Usage status for widget (now message-based)
=========================================================== */
app.get("/api/usage-status", async (req, res) => {
  const userId = req.headers["x-user-id"];
  if (!userId) return res.status(400).json({ error: "Missing userId" });

  const userSnap = await db.collection("users").doc(userId).get();
  const companyId = userSnap.data()?.companyId;
  if (!companyId) return res.status(404).json({ error: "User has no company linked" });

  const cSnap = await db.collection("companies").doc(companyId).get();
  const c = cSnap.data();
  if (!c) return res.status(404).json({ error: "Company not found" });

  let tier = c.tier || "free";
  const limit = MESSAGE_LIMITS[tier] ?? 150;
  const used = c.messagesUsedMonth || 0;

  // Safety: if cycle ended, show 0 used
  const cycleEnd = c.currentPeriodEnd?.toDate?.();
  const reset = cycleEnd && new Date() > cycleEnd;
  const usage = reset ? 0 : used;

  // If past_due/halted, block paid features
  const blocked =
    (tier === "free" && usage >= limit) ||
    ["past_due", "halted", "paused"].includes(c.subscriptionStatus || "");

  return res.json({
    usage,
    limit,
    blocked,
    subscriptionStatus: c.subscriptionStatus || null,
    currentPeriodEnd: c.currentPeriodEnd || null,
    tier,
  });
});

/* ===========================================================
   Legacy one-time order endpoints (kept for compatibility)
   — You can remove later. Prefer /api/billing/subscribe.
=========================================================== */
app.post("/api/create-order", async (req, res) => {
  return res.status(410).json({
    error:
      "Deprecated. Use /api/billing/subscribe for autopay subscriptions (monthly/yearly).",
  });
});

app.post("/api/verify-payment", async (_req, res) => {
  return res
    .status(410)
    .json({ success: false, message: "Deprecated. Using subscriptions now." });
});

/* ===========================================================
   Company registration (unchanged)
=========================================================== */
app.post("/api/register-company", async (req, res) => {
  const { userId, companyName } = req.body;
  if (!userId || !companyName) return res.status(400).json({ error: "Missing fields." });

  try {
    const companyDoc = await db.collection("companies").add({
      name: companyName,
      tier: "free",
      messagesUsedMonth: 0,
      createdAt: Timestamp.now(),
    });

    await db.collection("users").doc(userId).update({ companyId: companyDoc.id });

    res.json({ message: "Company registered & user linked.", companyId: companyDoc.id });
  } catch (err) {
    console.error("Company registration error:", err.message);
    res.status(500).json({ error: "Failed to register company." });
  }
});

/* ===========================================================
   Start server
=========================================================== */
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
