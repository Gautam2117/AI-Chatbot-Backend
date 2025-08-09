/* ─────────────────────────────────────────────────────────────
   dailyReset.js  •  Runs at local midnight (00:00 IST ⇢ 18:30 UTC)

   • Clears *daily* counters for every workspace
   • On the 1st of each month:
       – resets isOverageBilled (so add-ons can be billed again)
       – resets messagesUsedMonth for FREE workspaces
   • Uses Firestore BulkWriter for high-throughput, low-cost writes
────────────────────────────────────────────────────────────── */

import cron from "node-cron";
import { db } from "./firebase.js";
import { Timestamp, FieldValue } from "firebase-admin/firestore";

console.log("📆 Scheduling daily reset job (00:00 IST)…");

/* 00:00 IST == 18:30 UTC */
cron.schedule(
  "0 0 * * *",
  async () => {

    const nowIst = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
    const d = new Date(nowIst);
    const isFirstOfMonth = d.getDate() === 1;
    const writer         = db.bulkWriter();          // ⚡️ batched writes

    try {
      const snap = await db.collection("companies").get();

      snap.docs.forEach((doc) => {
        const data    = doc.data();
        const updates = {
          messagesUsedToday:       0,
          tokensUsedToday:         0,
          tokensUsedMonthLegacy:   FieldValue.delete(),
          lastReset:               Timestamp.now(),
        };

        /* — monthly housekeeping — */
        if (isFirstOfMonth) {
          updates.isOverageBilled = false;           // unlock new add-ons
          if ((data.tier || "free") === "free") {
            updates.messagesUsedMonth = 0;           // reset free quota
          }
        }

        writer.update(doc.ref, updates);
      });

      await writer.close();                          // flush batched writes
      console.log(
        `✅ Daily reset complete${isFirstOfMonth ? " + monthly reset" : ""}`
      );
    } catch (err) {
      console.error("❌ Daily reset failed:", err.message);
      await writer.close();                          // always flush pending ops
    }
  },
  { timezone: "Asia/Kolkata" }
);
