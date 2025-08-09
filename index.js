/*  Botify – backend
    Subscription billing (autopay), yearly cycles, message quotas
----------------------------------------------------------------- */

import "./dailyReset.js";
import { dedupe } from "./utils/dedupe.js";

import rateLimit          from "express-rate-limit";
import helmet             from "helmet";
import express            from "express";
import cors               from "cors";
import dotenv             from "dotenv";
import OpenAI             from "openai";
import Razorpay           from "razorpay";
import crypto             from "crypto";
import { Timestamp, FieldValue } from "firebase-admin/firestore";
import { db }             from "./firebase.js";
import stringSimilarity   from "string-similarity";
import basicAuth          from "express-basic-auth";
import natural from "natural";

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 5000;
app.set("trust proxy", 1);

/* ──────────────────────────────────
   CORS (public vs admin)
─────────────────────────────────── */

// Public endpoints used by the embeddable widget
const publicCors = cors({
  origin: true,                                 // reflect any Origin
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type","x-user-id"],
  credentials: false                            // widget doesn't use cookies
});

// Admin/billing endpoints — only your own apps should call these
const adminCors = cors({
  origin: [
    "https://ai-chatbot-saas-eight.vercel.app",
    "http://localhost:5173"
  ],
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type","x-user-id"],
  credentials: true
});

// Make sure preflight gets CORS headers
app.options("/api/*", publicCors);

// Apply CORS *before* any middlewares/handlers on those routes
app.use("/api/usage-status", publicCors);
app.use("/api/faqs",        publicCors);
app.use("/api/chat",        publicCors);

// Lock down sensitive routes
app.use("/api/billing",         adminCors);
app.use("/api/register-company", adminCors);

// (webhooks are server-to-server; CORS not required)

app.use(helmet());

/* ──────────────────────────────────
   Razorpay client
─────────────────────────────────── */
const keyId     = process.env.RAZORPAY_KEY_ID;
const keySecret = process.env.RAZORPAY_SECRET;
if (!keyId || !keySecret)
  throw new Error("Razorpay keys not found in environment.");

const razorpay  = new Razorpay({ key_id: keyId, key_secret: keySecret });

/* ──────────────────────────────────
   DeepSeek / OpenAI wrapper
─────────────────────────────────── */
if (!process.env.DEEPSEEK_API_KEY) throw new Error("Missing DEEPSEEK_API_KEY");

const openai = new OpenAI({
  apiKey : process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

process.on("unhandledRejection", (err) => console.error("UNHANDLED:", err));

/* ──────────────────────────────────
   Plan catalogue (prices in paise)
─────────────────────────────────── */
const PLAN_CATALOG = {
  /* Starter – 3 000 msgs / mo */
  starter_monthly: {
    tier: "starter", period: "monthly", interval: 1,
    amountPaise: 159_900,                              // ₹1 599.00
    name: "Botify Starter (3 000 msgs) — Monthly",
    envKey: "RP_PLAN_STARTER_MONTHLY",
  },
  starter_yearly:  {
    tier: "starter", period: "yearly",  interval: 1,
    amountPaise: 1_599_000,                            // ₹15 990.00 (2 mo free)
    name: "Botify Starter (3 000 msgs) — Yearly",
    envKey: "RP_PLAN_STARTER_YEARLY",
  },

  /* Growth – 15 000 msgs / mo */
  growth_monthly: {
    tier: "growth", period: "monthly", interval: 1,
    amountPaise: 489_900,                              // ₹4 899.00
    name: "Botify Growth (15 000 msgs) — Monthly",
    envKey: "RP_PLAN_GROWTH_MONTHLY",
  },
  growth_yearly:  {
    tier: "growth", period: "yearly",  interval: 1,
    amountPaise: 4_899_000,                            // ₹48 990.00
    name: "Botify Growth (15 000 msgs) — Yearly",
    envKey: "RP_PLAN_GROWTH_YEARLY",
  },

  /* Scale – 50 000 msgs / mo */
  scale_monthly: {
    tier: "scale", period: "monthly", interval: 1,
    amountPaise: 1_239_900,                            // ₹12 399.00
    name: "Botify Scale (50 000 msgs) — Monthly",
    envKey: "RP_PLAN_SCALE_MONTHLY",
  },
  scale_yearly:  {
    tier: "scale", period: "yearly",  interval: 1,
    amountPaise: 12_399_000,                           // ₹123 990.00
    name: "Botify Scale (50 000 msgs) — Yearly",
    envKey: "RP_PLAN_SCALE_YEARLY",
  },

  /* Overage add-on */
  overage_1k: {
    name: "Overage 1 000 messages",
    amountPaise: 32_900,                               // ₹329.00
  },
};

/* ──────────────────────────────────
   Monthly hard caps
─────────────────────────────────── */
const MESSAGE_LIMITS = {
  free:    150,
  starter: 3_000,
  growth:  15_000,
  scale:   50_000,
};

/* helper – rough token estimator (legacy analytics) */
const estTokens = (s = "") => Math.ceil(s.length / 4);

/* ╔═══════════════════════════════════════════════════════╗
   ║                INTERNAL  CRON  JOBS                   ║
   ╚═══════════════════════════════════════════════════════╝ */

/* ╔═══════════════════════════════════════════════════════╗
   ║                   RAZORPAY  WEBHOOK                   ║
   ╚═══════════════════════════════════════════════════════╝ */

app.post(
  "/api/razorpay-webhook",
  express.raw({ type: "application/json" }), // keep raw body for signature check
  async (req, res) => {
    const sigHdr = req.headers["x-razorpay-signature"];
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!sigHdr || !secret) return res.status(400).send("Missing signature/secret");

    // 1️⃣ Verify HMAC signature
    let raw;
    try {
      raw = req.body.toString("utf8");
    } catch {
      return res.status(400).send("Bad raw body");
    }
    const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(sigHdr || "");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {   return res.status(400).send("Invalid signature");
    }

    // 2️⃣ Parse event
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return res.status(400).send("Bad JSON");
    }
    const evt = event.event;

    // 3️⃣ Dedupe
    const dedupId =
      event.payload.subscription?.entity?.id ||
      event.payload.invoice?.entity?.id ||
      event.payload.payment?.entity?.id ||
      `${evt}:${event.created_at}`;
    const logRef = db.collection("webhookLogs").doc(dedupId);
    const prev = await logRef.get();
    if (prev.exists && prev.data().processed) {
      return res.status(200).send("dup");
    }

    try {
      // ─── When an invoice is paid, activate and set the tier ───
      if (evt === "invoice.paid") {
        const inv     = event.payload.invoice.entity;
        const subId   = inv.subscription_id;
        const notes   = inv.notes || {};
        const planKey = notes.planKey;
        const tier    = PLAN_CATALOG[planKey]?.tier || "starter";
        const interval = planKey?.includes("yearly") ? "yearly" : "monthly";

        // PATCH: fetch subscription for true cycle end (current_end / charge_at)
        let endTs = null;
        try {
          const sub = await razorpay.subscriptions.fetch(subId);
          const epoch = sub.current_end || sub.charge_at || null;
          if (epoch) endTs = Timestamp.fromDate(new Date(epoch * 1000));
        } catch (e) {
          console.warn("Could not fetch subscription for period end:", e?.error?.description || e.message);
        }

        const compSnap = await db
          .collection("companies")
          .where("subscriptionId", "==", subId)
          .limit(1)
          .get();

        if (!compSnap.empty) {
          await compSnap.docs[0].ref.set(
            {
              subscriptionStatus: "active",
              tier,
              billingInterval: interval,
              currentPeriodEnd: endTs,
              messagesUsedMonth: 0,
              isOverageBilled: false,
            },
            { merge: true }
          );
          console.log(`✅ Webhook: company ${compSnap.docs[0].id} is now active`);
        }
      }

      // ─── credit overage when a one-time payment is captured ───
      if (evt === "payment.captured") {
        const pay = event.payload.payment.entity;
        let notes = pay.notes || {};
        if ((!notes.companyId || !notes.blocks) && pay.order_id) {
          try {
            const order = await razorpay.orders.fetch(pay.order_id);
            notes = order.notes || notes;
          } catch (e) {
            console.warn("Could not fetch order for notes:", e?.error?.description || e.message);
          }
        }        
        if (notes.companyId && notes.blocks) {
          const compRef = db.collection("companies").doc(notes.companyId);
          await compRef.update({
            overageCredits: FieldValue.increment(parseInt(notes.blocks) * 1000)
          });
          console.log(
            `💰 Credited ${notes.blocks}k extra msgs to ${notes.companyId}`
          );
        }
      }

      // ─── When a payment fails, mark past_due ───
      else if (evt === "payment.failed") {
        const pay   = event.payload.payment.entity;
        const subId = pay.subscription_id;

        const compSnap = await db
          .collection("companies")
          .where("subscriptionId", "==", subId)
          .limit(1)
          .get();

        if (!compSnap.empty) {
          await compSnap.docs[0].ref.set(
            { subscriptionStatus: "past_due" },
            { merge: true }
          );
          console.log(
            `⚠️  Webhook: company ${compSnap.docs[0].id} payment failed`
          );
        }
      }

      // ─── Log as processed ───
      // PATCH: log minimally
      await logRef.set({
        ts: Timestamp.now(),
        evt,
        processed: true,
        // minimal pointers only:
        ids: {
          subscription: event.payload.subscription?.entity?.id || null,
          invoice: event.payload.invoice?.entity?.id || null,
          payment: event.payload.payment?.entity?.id || null,
        },
        eventId: req.headers["x-razorpay-event-id"] || null,
      });
    } catch (err) {
      console.error("Webhook handler error:", err);
      await logRef.set({
        ts: Timestamp.now(),
        evt,
        error: err.message,
        processed: false,
        ids: {
          subscription: event.payload?.subscription?.entity?.id || null,
          invoice:      event.payload?.invoice?.entity?.id || null,
          payment:      event.payload?.payment?.entity?.id || null,
        },
        eventId: req.headers["x-razorpay-event-id"] || null,
      });
    }

    res.status(200).send("ok");
  }
);

/* body-parser AFTER webhook */
app.use(express.json({ limit: "1mb" }));

/* ╔═══════════════════════════════════════════════════════╗
   ║                     HELPERS                           ║
   ╚═══════════════════════════════════════════════════════╝ */

async function getCompanyIdForUser(userId) {
  const snap = await db.collection("users").doc(userId).get();
  if (!snap.exists) throw Object.assign(new Error("User not found"), { code: 404 });
  const companyId = snap.data()?.companyId;
  if (!companyId)   throw Object.assign(new Error("No company linked"), { code: 404 });
  return companyId;
}

const planCache = new Map();

async function getOrCreateRazorpayPlan (planKey) {
  const cfg = PLAN_CATALOG[planKey];
  if (!cfg) throw Object.assign(new Error("Unknown planKey"), { code: 400 });

  /* Use cached / env-provided ID if available */
  if (process.env[cfg.envKey]) return process.env[cfg.envKey];
  if (planCache.has(planKey))  return planCache.get(planKey);

  const plan = await razorpay.plans.create({
    period:   cfg.period,
    interval: cfg.interval,
    item: {
      name:        cfg.name,
      amount:      cfg.amountPaise,
      currency:    "INR",
      description: {
        starter: "Up to 3 000 messages / month",
        growth : "Up to 15 000 messages / month",
        scale  : "Up to 50 000 messages / month",
      }[cfg.tier] || "Botify subscription",
    },
    notes: { planKey },
  });

  planCache.set(planKey, plan.id);
  console.log(`🆕 Razorpay plan created: ${planKey} → ${plan.id}`);
  return plan.id;
}

/* ╔═══════════════════════════════════════════════════════╗
   ║              PUBLIC  STATUS  ENDPOINTS                ║
   ╚═══════════════════════════════════════════════════════╝ */

app.get("/", (_req, res) => res.send("✅ Botify backend running."));

app.get("/api/billing/plans", (_req, res) => {
  const toRs = (p) => Math.round(p / 100);
  res.json({
    currency: "INR",

    starter: {
      monthly: {
        price:    toRs(PLAN_CATALOG.starter_monthly.amountPaise),
        messages: 3_000,
        planKey:  "starter_monthly",
      },
      yearly: {
        price:    toRs(PLAN_CATALOG.starter_yearly.amountPaise),
        messages: 3_000,
        planKey:  "starter_yearly",
      },
    },

    growth: {
      monthly: {
        price:    toRs(PLAN_CATALOG.growth_monthly.amountPaise),
        messages: 15_000,
        planKey:  "growth_monthly",
      },
      yearly: {
        price:    toRs(PLAN_CATALOG.growth_yearly.amountPaise),
        messages: 15_000,
        planKey:  "growth_yearly",
      },
    },

    scale: {
      monthly: {
        price:    toRs(PLAN_CATALOG.scale_monthly.amountPaise),
        messages: 50_000,
        planKey:  "scale_monthly",
      },
      yearly: {
        price:    toRs(PLAN_CATALOG.scale_yearly.amountPaise),
        messages: 50_000,
        planKey:  "scale_yearly",
      },
    },

    overage: { per_1k: toRs(PLAN_CATALOG.overage_1k.amountPaise) },
  });
});

// PATCH: extract subscribe logic so switch can reuse it safely
async function createSubscription({ planKey, userId, companyId, customer }) {
  if (!planKey) throw Object.assign(new Error("Missing planKey"), { code: 400 });

  // 1) Resolve company
  const targetCompanyId = companyId || (userId ? await getCompanyIdForUser(userId) : null);
  if (!targetCompanyId) throw Object.assign(new Error("Missing companyId"), { code: 400 });

  // 2) Reject if already on that exact plan
  const cSnap = await db.collection("companies").doc(targetCompanyId).get();
  const existing  = cSnap.data() || {};
  const currentKey = `${(existing.tier || "free")}_${existing.billingInterval || "monthly"}`;
  if (currentKey === planKey) throw Object.assign(new Error("Already on that plan"), { code: 400 });

  // 3) Ensure Razorpay plan exists
  const planId = await getOrCreateRazorpayPlan(planKey);

  // 4) (optional) Create / reuse Razorpay customer
  let customerId = null;
  if (customer?.email) {
    try {
      const c = await razorpay.customers.create({
        name:    customer.name || "Botify User",
        email:   customer.email,
        contact: customer.contact || undefined,
        notes:   { companyId: targetCompanyId, userId: userId || "" },
      });
      customerId = c.id;
    } catch {/* best-effort */}
  }

  // 5) Create subscription
  const cycles = planKey.includes("yearly") ? 100 /* years */ : 1200 /* months */; // allowed long-lived
  const sub = await razorpay.subscriptions.create({
    plan_id:         planId,
    total_count:     cycles,
    customer_notify: 1,
    customer_id:     customerId || undefined,
    notes:           { planKey, companyId: targetCompanyId, userId: userId || "" },
  });

  // 6) Persist shell
  await db.collection("companies").doc(targetCompanyId).set({
    subscriptionId:     sub.id,
    subscriptionStatus: sub.status,
    billingInterval:    planKey.includes("yearly") ? "yearly" : "monthly",
    currentPeriodEnd:   null,
  }, { merge: true });

  // 7) Return checkout payload
  return {
    subscriptionId: sub.id,
    shortKey:       planKey,
    status:         sub.status,
    checkout: {
      key:             process.env.RAZORPAY_KEY_ID,
      subscription_id: sub.id,
      customer_id:     customerId,
      name:            "Botify",
      description:     PLAN_CATALOG[planKey].name,
      notes:           { planKey, companyId: targetCompanyId },
    },
  };
}


// PATCH: subscribe uses helper
app.post("/api/billing/subscribe", async (req, res) => {
  try {
    const out = await createSubscription(req.body || {});
    res.json(out);
  } catch (e) {
    console.error("subscribe error:", e);
    res.status(e.code === 400 ? 400 : 500).json({
      error: e?.error?.description || e.message || "Subscribe failed",
    });
  }
});

// PATCH: switch cancels old (at period end) then creates new
app.post("/api/billing/switch", async (req, res) => {
  try {
    const { planKey, companyId } = req.body || {};
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

    const out = await createSubscription({ planKey, companyId });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
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
// PATCH: TTL cleanup for IP counters (once per minute)
setInterval(() => {
  const now = Date.now();
  for (const [ip, v] of hits) {
    if (now > (v.resetAt || 0) + 60_000) hits.delete(ip);
  }
}, 60_000).unref?.();

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

// PATCH: enforce membership and forbid arbitrary companyId pulls
app.get("/api/faqs", async (req, res) => {
  try {
    const qUserId    = (req.query.userId || req.headers["x-user-id"] || "").toString();
    const reqCompany = (req.query.companyId || "").toString();
    if (!qUserId) return res.status(401).json({ error: "Auth required (x-user-id)" });

    // resolve user's company
    const userSnap = await db.collection("users").doc(qUserId).get();
    if (!userSnap.exists) return res.status(404).json({ error: "User not found" });
    const userCompanyId = userSnap.data()?.companyId;
    if (!userCompanyId) return res.status(400).json({ error: "User not linked to company" });

    // if a companyId was supplied, it MUST match the user's company
    if (reqCompany && reqCompany !== userCompanyId)
      return res.status(403).json({ error: "Forbidden for this company" });

    const companyId = userCompanyId;
    const snap = await db.collection("faqs").doc(companyId).collection("list").limit(200).get();

    let faqs = snap.docs.map((d) => {
      const x = d.data();
      const q = (x.q ?? x.question ?? x.title ?? "").toString().trim();
      const a = (x.a ?? x.answer ?? "").toString().trim();
      return q && a ? { id: d.id, question: q, answer: a } : null;
    }).filter(Boolean)
     .sort((a,b)=> a.id.localeCompare(b.id)); // PATCH: stable order for ETag

    const etag = crypto.createHash("sha1").update(JSON.stringify(faqs)).digest("hex");
    if (req.headers["if-none-match"] === etag) return res.status(304).end();

    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, max-age=60, stale-while-revalidate=120");
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

  /* ─── time‐box to 60s ────────────────────────────────────── */
  res.setTimeout(60_000, () => {
    try { res.write("\n[Error: timeout]"); } finally { res.end(); }
  });

  /* ─── validate input ────────────────────────────────────── */
  const userId = req.headers["x-user-id"];
  if (!userId) return res.status(401).json({ error: "Auth required (x-user-id)" });
  const qRaw = typeof req.body.question === "string"
    ? req.body.question.trim()
    : "";
  if (!qRaw) {
    return res.status(400).json({ error: "Missing or invalid question." });
  }
  if (qRaw.length > 2000) {
    return res
      .status(400)
      .json({ error: "Question too long (2 000 chars max)." });
  }
  if (qRaw.split(/\s+/).length < 2) {
    return res
      .status(400)
      .json({ error: "Please ask a more specific question." });
  }

  /* ─── fetch user & company ───────────────────────────────── */
  const userSnap = await db.collection("users").doc(userId).get();
  if (!userSnap.exists) {
    return res.status(404).json({ error: "User not found." });
  }
  const companyId = userSnap.data()?.companyId;
  if (!companyId) {
    return res
      .status(400)
      .json({ error: "User not linked to a company." });
  }
  const companyRef = db.collection("companies").doc(companyId);
  const companyDoc = await companyRef.get();
  if (!companyDoc.exists) {
    return res.status(404).json({ error: "Company not found." });
  }

  /* ─── quota + overage check & reserve atomically ──────────── */
  const reserveResult = await db.runTransaction(async (tx) => {
    const snap = await tx.get(companyRef);
    const c = snap.data() || {};

    // downgrade to "free" if subscription halted/paused/created
    const tierRaw = c.tier || "free";
    const tier = ["halted", "paused", "created"].includes(
      c.subscriptionStatus
    )
      ? "free"
      : tierRaw;

    const monthlyLimit = MESSAGE_LIMITS[tier] ?? 150;
    // how many used so far
    let used = c.messagesUsedMonth || 0;
    // reset if billing period ended
    const end = c.currentPeriodEnd?.toDate?.();
    const cycleReset = end && new Date() > end;
    if (cycleReset) {
      used = 0;
    }
    // how many extra messages remain
    const credits = c.overageCredits || 0;

    // if over monthly limit *and* no credits left → block
    if (used >= monthlyLimit && credits <= 0) {
      return { allowed: false };
    }

    // build our update
    const updates = {
      messagesUsedMonth: used + 1,
      lastMsgAt: Timestamp.now(),
      messagesUsedToday: (c.messagesUsedToday || 0) + 1,
    };
    if (cycleReset) {
      updates.currentPeriodEnd = null;
      updates.messagesUsedMonth = 1;
    }
    // if we're beyond the monthly limit, consume one credit
    if (used >= monthlyLimit && credits > 0) {
      updates.overageCredits = credits - 1;
    }

    // reserve
    tx.update(companyRef, updates);
    return { allowed: true, tier, monthlyLimit };
  });

  if (!reserveResult.allowed) {
    return res
      .status(403)
      .json({
        error:
          "Monthly message limit reached and no overage credits left. Please upgrade to continue.",
      });
  }

  /* ─── load FAQs ───────────────────────────────────────────── */
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
        a: (f.a ?? f.answer ?? "").toString().trim(),
      }))
      .filter((f) => f.q && f.a);
  } catch (e) {
    console.warn("FAQ fetch failed:", e.message);
  }

  const stem = (w) => natural.PorterStemmer.stem(w);

  const normalize = (s = "") =>
    s
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .map(stem)           // 🎯 new!
      .join(" ");

  /* ─── exact FAQ match ─────────────────────────────────────── */
  const exact = faqs.find((f) => normalize(f.q) === normalize(qRaw));
  if (exact) {
    return res.type("text/plain").send(dedupe(exact.a));
  }

  /* ─── fuzzy FAQ match ─────────────────────────────────────── */
  try {
    const qs = faqs.map((f) => f.q);
    if (qs.length) {
      const { bestMatch, bestMatchIndex } = stringSimilarity.findBestMatch(
        qRaw,
        qs
      );
    const jaccard = (a, b) => {
     const setA = new Set(a.split(/\s+/));
     const setB = new Set(b.split(/\s+/));
     const intersect = [...setA].filter(x => setB.has(x)).length;
     return intersect / (setA.size + setB.size - intersect);
    };

    const sim   = bestMatch?.rating ?? 0;
    const jac   = jaccard(normalize(qRaw), normalize(qs[bestMatchIndex]));

    // hit if EITHER metric is good enough
    if (sim >= 0.70 || jac >= 0.45) {
        return res.type("text/plain").send(dedupe(faqs[bestMatchIndex].a));
      }
    }
  } catch (e) {
    console.warn("Fuzzy match failed:", e.message);
  }

  const faqPrefix = faqs
  .slice(0, 5)
  .map((f, i) => `${i + 1}. Q: ${f.q}\n   A: ${f.a}`)
  .join("\n");


  const SYS  = "You are Botify, an AI customer-support assistant. Keep answers ≤ 3 sentences.";
  const USER = (faqs.length ? `Helpful FAQs:\n${faqPrefix}\n\n` : "") + qRaw;

  /* ─── LLM fallback (non-stream, deduped) ───────────────────── */
  try {
    const llm = await openai.chat.completions.create({
      model: "deepseek-chat",
      temperature: 0.15,
      max_tokens: 150,
      frequency_penalty: 1.2,   // discourages repetition
      presence_penalty : 0.9,
      messages: [
        { role: "system", content: SYS },
        { role: "user",   content: USER },
      ],
    });

    let replyText = llm.choices?.[0]?.message?.content
                  || "Sorry, I’m not sure.";

    /* wipe 1- to 4-word repeats + glued “wordword” */
    replyText = dedupe(replyText);

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.type("text/plain").send(replyText);
  } catch (e) {
    console.error("LLM error:", e);
    return res.status(500).send("Generation failed.");
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

  let tier = (c.tier || "free").toLowerCase();
  const limit = (MESSAGE_LIMITS[tier] ?? 150);
  const used  = c.messagesUsedMonth || 0;

  const cycleEnd = c.currentPeriodEnd?.toDate?.();
  const reset    = cycleEnd && new Date() > cycleEnd;
  const usage    = reset ? 0 : used;

  const status   = (c.subscriptionStatus || "").toLowerCase();
  const credits  = c.overageCredits || 0;

  // align with /api/chat: block ONLY if out of messages AND no credits,
  // or if the subscription is not usable.
  const hardBlockStatuses = new Set(["past_due", "halted", "paused", "created"]); // include "created" if you want pending to block
  const blocked = hardBlockStatuses.has(status) || (usage >= limit && credits <= 0);

  return res.json({
    usage,
    limit,
    blocked,
    blockedReason: blocked
      ? (hardBlockStatuses.has(status) ? `sub_${status}` : (credits <= 0 ? "quota_exhausted" : ""))
      : null,
    subscriptionStatus: c.subscriptionStatus || null,
    currentPeriodEnd: c.currentPeriodEnd || null,
    tier,
    overageCredits: credits,
  });
});

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
      overageCredits: 0,
    });

    await db.collection("users").doc(userId).update({ companyId: companyDoc.id });

    res.json({ message: "Company registered & user linked.", companyId: companyDoc.id });
  } catch (err) {
    console.error("Company registration error:", err.message);
    res.status(500).json({ error: "Failed to register company." });
  }
});

/* ===========================================================
   One-off overage purchase → Razorpay Order (≤40-char receipt)
=========================================================== */
app.post("/api/billing/create-overage-order", async (req, res) => {
  const { userId, blocks = 1 } = req.body;

  if (!userId)                     return res.status(400).json({ error: "Missing userId" });
  if (blocks < 1 || blocks > 20)   return res.status(400).json({ error: "Invalid blocks (1–20)" });

  try {
    /* 1️⃣  Resolve company and make sure the sub is active */
    const userSnap   = await db.collection("users").doc(userId).get();
    const companyId  = userSnap.data()?.companyId;
    if (!companyId)  return res.status(400).json({ error: "No company linked" });

    const compSnap   = await db.collection("companies").doc(companyId).get();
    if (compSnap.data()?.subscriptionStatus !== "active")
      return res.status(403).json({ error: "Subscription not active" });

    /* 2️⃣  Build order */
    const amount   = PLAN_CATALOG.overage_1k.amountPaise * blocks;        // e.g. 32 900 × blocks
    const ts       = Date.now().toString().slice(-8);                     // last 8 digits
    const receipt  = `ov_${companyId.slice(0,10)}_${ts}`.slice(0,40);     // ≤ 40 chars ✅

    const order = await razorpay.orders.create({
      amount,
      currency : "INR",
      receipt,
      notes    : { companyId, blocks: blocks.toString() },
    });

    return res.json({
      orderId : order.id,
      amount  : order.amount,
      currency: order.currency,
      key     : process.env.RAZORPAY_KEY_ID,
    });
  } catch (e) {
    console.error("create-order error:", e);
    return res.status(500).json({ error: "Could not create order" });
  }
});

/* ===========================================================
   Start server
=========================================================== */
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
