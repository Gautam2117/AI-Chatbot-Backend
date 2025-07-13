// server/dailyReset.js
import cron from "node-cron";
import { db } from "./firebase.js";
import { Timestamp } from "firebase-admin/firestore";

console.log("📆 Scheduling daily reset job...");

cron.schedule("30 18 * * *", async () => {
  try {
    const snapshot = await db.collection("companies").get();

    for (const doc of snapshot.docs) {
      await doc.ref.update({
        tokensUsedToday: 0,
        lastReset: Timestamp.now(),
      });
    }

    console.log("✅ Daily reset completed");
  } catch (err) {
    console.error("❌ Daily reset failed:", err.message);
  }
});
