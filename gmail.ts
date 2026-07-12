import fs from "fs/promises";
import path from "path";
import { google } from "googleapis";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
];

const CREDENTIALS_PATH = path.join(__dirname, "credentials.json");
const TOKEN_PATH = path.join(__dirname, "token.json");

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

  await fs.writeFile(
    TOKEN_PATH,
    JSON.stringify(tokens, null, 2)
  );

  return oauth2Client;
}

async function loadSavedCredentials() {
  try {
    const oauth2Client = await getOAuthClient();

    const token = await fs.readFile(TOKEN_PATH, "utf8");

    oauth2Client.setCredentials(JSON.parse(token));

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
    await fs.rm(TOKEN_PATH, { force: true });

    throw new Error("TOKEN_EXPIRED");
  }
}