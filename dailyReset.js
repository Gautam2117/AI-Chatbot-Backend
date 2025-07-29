// server/dailyReset.js
import cron from "node-cron";
import { db } from "./firebase.js";
import { Timestamp } from "firebase-admin/firestore";

console.log("📆 Scheduling daily reset job...");

cron.schedule("30 18 * * *", async () => {
  try {
    const now = new Date();
    const isFirstOfMonth = now.getDate() === 1;

    const snapshot = await db.collection("companies").get();

    for (const doc of snapshot.docs) {
      const updates = {
        tokensUsedToday: 0,
        lastReset: Timestamp.now(),
      };

      if (isFirstOfMonth) {
        updates.tokensUsedMonth = 0;
      }

      await doc.ref.update(updates);
    }

    console.log(`✅ Daily reset${isFirstOfMonth ? " with monthly reset" : ""} completed`);
  } catch (err) {
    console.error("❌ Daily reset failed:", err.message);
  }
});
