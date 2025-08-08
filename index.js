/*  Botify – backend
    Subscription billing (autopay), yearly cycles, message quotas
----------------------------------------------------------------- */

import "./dailyReset.js";
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

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 5000;
app.set("trust proxy", 1);

/* ──────────────────────────────────
   CORS
─────────────────────────────────── */

const WHITELIST = [
  "https://ai-chatbot-saas-eight.vercel.app",
  "http://localhost:5173",
];

// one single options object
const corsOptions = {
  origin: (origin, cb) => cb(null, !origin || WHITELIST.includes(origin)),
  credentials: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-user-id"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));  // attach CORS headers
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
    amountPaise: 1_599_900,                            // ₹15 990.00 (2 mo free)
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

app.post(
  "/internal/overage-run",
  basicAuth({
    users: { [process.env.CRON_USER]: process.env.CRON_PASS },
    challenge: true,
  }),
  async (_req, res) => {
    try {
      await nightlyOverageJob();
      res.json({ ok: true });
    } catch (e) {
      console.error("Overage CRON error", e);
      res.status(500).json({ error: e.message });
    }
  }
);

async function nightlyOverageJob() {
  const snaps = await db.collection("companies").where("subscriptionId", "!=", null).get();

  for (const doc of snaps.docs) {
    const c       = doc.data();
    const limit   = MESSAGE_LIMITS[c.tier] ?? 0;
    const used    = c.messagesUsedMonth || 0;
    const over    = Math.max(0, used - limit);
    const blocks  = Math.floor(over / 1_000);
    if (blocks === 0 || c.isOverageBilled) continue;

    try {
      await razorpay.addons.create({
        subscription_id: c.subscriptionId,
        item: {
          name:     `Overage ${blocks * 1_000} messages`,
          amount:   PLAN_CATALOG.overage_1k.amountPaise * blocks,
          currency: "INR",
        },
        quantity: 1,
      });
      await doc.ref.update({ isOverageBilled: true });
      console.log(`💸 Overage billed for ${doc.id}: +${blocks}k`);
    } catch (e) {
      console.error("Add-on create failed:", e);
    }
  }
}

/* ╔═══════════════════════════════════════════════════════╗
   ║                   RAZORPAY  WEBHOOK                   ║
   ╚═══════════════════════════════════════════════════════╝ */

app.post(
  "/api/razorpay-webhook",
  express.raw({ type: "application/json" }),            // keep raw body
  async (req, res) => {
    const sigHdr = req.headers["x-razorpay-signature"];
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!sigHdr || !secret) return res.status(400).send("Missing signature/secret");

    /* verify HMAC */
    let raw;
    try { raw = req.body.toString("utf8"); }
    catch { return res.status(400).send("Bad raw body"); }

    const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sigHdr)))
      return res.status(400).send("Invalid signature");

    let event;
    try { event = JSON.parse(raw); }
    catch { return res.status(400).send("Bad JSON"); }

    const evt   = event?.event;
    const dedup = event?.payload?.subscription?.entity?.id
               || event?.payload?.invoice?.entity?.id
               || event?.payload?.payment?.entity?.id
               || `${evt}:${event?.created_at}`;

    const logRef = db.collection("webhookLogs").doc(dedup);
    if ((await logRef.get()).data()?.processed) return res.status(200).end("dup");

    try {
      /* subscription.* */
      if (evt?.startsWith("subscription.")) {
        const sub   = event.payload.subscription.entity;
        const notes = sub.notes || {};
        const companyId = notes.companyId || (await getCompanyIdForUser(notes.userId).catch(() => null));
        if (companyId) {
          await db.collection("companies").doc(companyId).set({
            subscriptionId:     sub.id,
            subscriptionStatus: sub.status,
            tier:               PLAN_CATALOG[notes.planKey]?.tier || "starter",
            billingInterval:    notes.planKey?.includes("yearly") ? "yearly" : "monthly",
            currentPeriodEnd:   sub.current_end ? Timestamp.fromDate(new Date(sub.current_end * 1_000)) : null,
            messagesUsedMonth:  0,
            lastMsgAt:          Timestamp.now(),
          }, { merge: true });
          console.log(`✅ Webhook: ${companyId} set to ${sub.status}`);
        }
      }

      /* invoice.paid */
      else if (evt === "invoice.paid") {
        const inv   = event.payload.invoice.entity;
        const subId = inv.subscription_id;
        if (subId) {
          const comp = await db.collection("companies").where("subscriptionId", "==", subId).limit(1).get();
          if (!comp.empty) {
            const ref = comp.docs[0].ref;
            let endTs = null;
            try {
              const s = await razorpay.subscriptions.fetch(subId);
              if (s?.current_end) endTs = Timestamp.fromDate(new Date(s.current_end * 1_000));
            } catch {}
            await ref.set({
              messagesUsedMonth: 0,
              currentPeriodEnd:  endTs || FieldValue.delete(),
              subscriptionStatus:"active",
              isOverageBilled:   false,
            }, { merge: true });
          }
        }
      }

      /* payment.failed */
      else if (evt === "payment.failed") {
        const pay   = event.payload.payment.entity;
        const subId = pay.subscription_id;
        if (subId) {
          const comp = await db.collection("companies").where("subscriptionId", "==", subId).limit(1).get();
          if (!comp.empty)
            await comp.docs[0].ref.set({ subscriptionStatus: "past_due" }, { merge: true });
        }
      }

      await logRef.set({ ts: Timestamp.now(), evt, raw: event, processed: true });
    } catch (e) {
      console.error("Webhook error:", e);
      await logRef.set({ ts: Timestamp.now(), evt, raw: event, error: e.message, processed: false });
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
async function getOrCreateRazorpayPlan(planKey) {
  const cfg = PLAN_CATALOG[planKey];
  if (!cfg) throw Object.assign(new Error("Unknown planKey"), { code: 400 });

  /* environment override */
  if (process.env[cfg.envKey]) return process.env[cfg.envKey];
  if (planCache.has(planKey))  return planCache.get(planKey);

  /* create on-the-fly */
  const descMap = {
    starter: "Up to 3 000 messages / month",
    growth:  "Up to 15 000 messages / month",
    scale:   "Up to 50 000 messages / month",
  };

  const plan = await razorpay.plans.create({
    period:   cfg.period === "yearly" ? "year" : "month",
    interval: cfg.interval,
    addon_applicable: 1,
    item: {
      name:        cfg.name,
      amount:      cfg.amountPaise,
      currency:    "INR",
      description: descMap[cfg.tier] || "Botify subscription",
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

/* ╔═══════════════════════════════════════════════════════╗
   ║               SUBSCRIPTION  HANDLERS                  ║
   ╚═══════════════════════════════════════════════════════╝ */

app.post("/api/billing/subscribe", async (req, res) => {
  try {
    const { planKey, userId, companyId, customer } = req.body;
    if (!planKey) return res.status(400).json({ error: "Missing planKey" });

    const planId         = await getOrCreateRazorpayPlan(planKey);
    const targetCompanyId= companyId || (userId ? await getCompanyIdForUser(userId) : null);
    if (!targetCompanyId) return res.status(400).json({ error: "Missing companyId" });

    /* create (or reuse) customer */
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
      } catch { /* optional */ }
    }

    const MAX_YEARS = 100;
    const cycles    = planKey.includes("yearly") ? MAX_YEARS : MAX_YEARS * 12;

    const sub = await razorpay.subscriptions.create({
      plan_id:         planId,
      total_count:     cycles,
      customer_notify: 1,
      customer_id:     customerId || undefined,
      notes: { planKey, companyId: targetCompanyId, userId: userId || "" },
    });

    /* store shell */
    await db.collection("companies").doc(targetCompanyId).set({
      subscriptionId:     sub.id,
      subscriptionStatus: sub.status,
      tier:               PLAN_CATALOG[planKey].tier,
      billingInterval:    planKey.includes("yearly") ? "yearly" : "monthly",
      currentPeriodEnd:   sub.current_end ? Timestamp.fromDate(new Date(sub.current_end * 1_000)) : null,
    }, { merge: true });

    res.json({
      subscriptionId: sub.id,
      shortKey:       planKey,
      status:         sub.status,
      checkout: {
        key:             keyId,
        subscription_id: sub.id,
        customer_id:     customerId,
        name:            "Botify",
        description:     PLAN_CATALOG[planKey].name,
        notes:           { planKey, companyId: targetCompanyId },
      },
    });
  } catch (e) {
    console.error("subscribe error:", e);
    res.status(500).json({ error: e?.error?.description || e.message || "Subscribe failed" });
  }
});

/* add-on 1 000 messages */
app.post("/api/billing/buy-overage", async (req, res) => {
  const { userId, blocks = 1 } = req.body;
  if (!userId) return res.status(400).json({ error: "Missing userId" });
  if (blocks < 1 || blocks > 20) return res.status(400).json({ error: "Invalid blocks" });

  try {
    const companyId = await getCompanyIdForUser(userId);
    const snap      = await db.collection("companies").doc(companyId).get();
    const subId     = snap.data()?.subscriptionId;
    if (!subId) return res.status(400).json({ error: "No active subscription" });

    const addon = await razorpay.addons.create({
      subscription_id: subId,
      item: {
        name:     `Pre-paid ${blocks * 1_000} messages`,
        amount:   PLAN_CATALOG.overage_1k.amountPaise * blocks,
        currency: "INR",
      },
      quantity: 1,
    });

    await snap.ref.update({ isOverageBilled: true });
    res.json({ ok: true, addonId: addon.id });
  } catch (e) {
    console.error("buy-overage error:", e);
    res.status(500).json({ error: e.message });
  }
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

    const MAX_YEARS = 100;
    const cycles =
      planKey.includes('yearly') ? MAX_YEARS : MAX_YEARS * 12;

    // NOTE: total_count — if omitted/0, Razorpay treats it as "auto-renew till cancelled".
    const sub = await razorpay.subscriptions.create({
      plan_id: planId,
      total_count: cycles,
      customer_notify: 1,
      customer_id: customerId || undefined,
      notes: { planKey, companyId: targetCompanyId, userId: userId || "" },
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
    console.error("subscribe error", e);          // still in logs

    /* Bubble a safe message back so the FE can show it */
    const msg =
      e?.error?.description        // Razorpay REST errors
    || e?.message                  // ordinary JS Error
    || "Unknown subscribe error";

    res.status(500).json({ error: msg });
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

    const addon = await razorpay.addons.create({
      subscription_id: subId,
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
