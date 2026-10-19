import dotenv from "dotenv";
import path from "path";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

dotenv.config({ path: "config.env" });

const serviceAccountPath =
  process.env.FIREBASE_SERVICE_ACCOUNT_PATH ??
  path.join(process.cwd(), "firebase-service-account.json");

const app =
  getApps().length > 0
    ? getApps()[0]
    : initializeApp({
        credential: cert(serviceAccountPath),
      });

export const db = getFirestore(app);