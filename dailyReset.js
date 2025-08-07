// server/dailyReset.js
import cron from "node-cron";
import { db } from "./firebase.js";
import { Timestamp } from "firebase-admin/firestore";

console.log("📆 Scheduling daily reset job (00:00 IST)…");

/*
 * Runs every day at 18:30 UTC = 00:00 IST
 * • Clears legacy token counters (optional)
 * • Clears messagesUsedMonth for FREE workspaces on the 1st
 * • Resets isOverageBilled at start of every month
 */
cron.schedule(
  "0 0 * * *", // ⏰ adjust if your host isn’t UTC
  async () => {
    try {
      const now = new Date();
      const firstOfMonth = now.getDate() === 1;

      const snap = await db.collection("companies").get();
      for (const doc of snap.docs) {
        const data = doc.data();
        const updates = {
          // legacy – harmless to keep
          messagesUsedToday: 0,
          tokensUsedToday: 0,
          tokensUsedMonth: firstOfMonth ? 0 : FieldValue.delete?.() ?? 0,
          lastReset: Timestamp.now(),
        };

        /* monthly work */
        if (firstOfMonth) {
          updates.isOverageBilled = false;      // allow next-cycle add-on
          updates.messagesUsedMonth = 0;          // legacy
          if ((data.tier || "free") === "free") {
            updates.messagesUsedMonth = 0;      // reset free plan quota
          }
        }

        await doc.ref.update(updates);
      }

      console.log(
        `✅ Daily reset done${firstOfMonth ? " (+monthly reset)" : ""}`
      );
    } catch (err) {
      console.error("❌ Daily reset failed:", err.message);
    }
  },
  { timezone: "Asia/Kolkata" }          // ensure cron fires at local midnight
);
