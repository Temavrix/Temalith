import fs from "fs/promises";
import path from "path";
import { google } from "googleapis";
import { db } from "./firebase";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
];

const CREDENTIALS_PATH =
  process.env.GMAIL_CREDENTIALS_PATH ??
  path.join(__dirname, "credentials.json");
  
async function saveToken(tokens: object) {
  await db.collection("gmailTokens").doc("default").set({
    tokens,
  });
}

async function loadToken() {
  const doc = await db
    .collection("gmailTokens")
    .doc("default")
    .get();

  if (!doc.exists) return null;

  return doc.data()?.tokens ?? null;
}

interface CredentialsFile {
  installed?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
  web?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
}


async function loadCredentials(): Promise<CredentialsFile> {
  const raw = await fs.readFile(CREDENTIALS_PATH, "utf8");
  return JSON.parse(raw);
}

export async function getOAuthClient() {
  const credentials = await loadCredentials();

  const config = credentials.installed ?? credentials.web;

  if (!config) {
    throw new Error(
      "Invalid credentials.json. Expected an 'installed' or 'web' section."
    );
  }

  const { client_id, client_secret, redirect_uris } = config;

  return new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );
}

export async function getAuthUrl(): Promise<string> {
  const oauth2Client = await getOAuthClient();

  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });
}

export async function handleOAuthCallback(code: string) {
  const oauth2Client = await getOAuthClient();

  const { tokens } = await oauth2Client.getToken(code);

  oauth2Client.setCredentials(tokens);

  await saveToken(tokens);

  return oauth2Client;
}

async function loadSavedCredentials() {
  try {
    const oauth2Client = await getOAuthClient();

    const token = await loadToken();

    if (!token) return null;

    oauth2Client.setCredentials(token);

    return oauth2Client;
  } catch {
    return null;
  }
}

export async function getGmailService() {
  const auth = await loadSavedCredentials();

  if (!auth) {
    throw new Error("NOT_AUTHENTICATED");
  }

  try {
    await auth.getAccessToken();

    return google.gmail({
      version: "v1",
      auth,
    });
  } catch {
    throw new Error("TOKEN_EXPIRED");
  }
}