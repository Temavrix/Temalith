import express, { Request, Response} from "express";
import fetch from "node-fetch";
import cors from "cors";
import axios from "axios";
import { createClient } from "redis";
import dotenv from "dotenv";
import { getGmailService } from "./gmail";
import { getAuthUrl } from "./gmail";
import { handleOAuthCallback } from "./gmail";

dotenv.config({ path: "config.env" });

const app = express();

app.use(cors());
app.use(express.json());

const TIINGO_API_KEY: string = process.env.TIINGO_API_KEY ?? "";
const redisUrl: string = process.env.REDIS_URL ?? "";
const newapikey = process.env.GNEWS_API_KEY ?? "";

if (!TIINGO_API_KEY) {
    throw new Error("Missing TIINGO_API_KEY");
}


// ===================== NEXAVIEW - REDIS =====================
// Redis client
const cli = createClient({
  url: redisUrl,
});

cli.on("error", (err: Error) => {
  console.error("Redis error:", err);
});

(async (): Promise<void> => {
  try {
    await cli.connect();
    console.log("Redis is connected");
  } catch (err) {
    console.error(
      "ERROR: Redis connection failed:",
      err instanceof Error ? err.message : err
    );
  }
})();


// Redis Key Helpers
const redisStockKey = (symbol: string): string =>
  `stock:${symbol.toUpperCase()}`;

const redisWeatherKey = (city: string): string =>
  `weather:${city.toLowerCase()}`;

const redisForecastKey = (city: string): string =>
  `forecast:${city.toLowerCase()}`;

const redisNewsKey = (
  country: string,
  category: string
): string => `gnews:${country}:${category}`;



// Fetch from Stock from Tiingo and store in Redis for 2 hours
async function fetchAndStoreStock(symbol: string): Promise<number | null> {
  const response = await axios.get(
    `https://api.tiingo.com/tiingo/daily/${symbol}/prices`,
    {
      params: {
        token: TIINGO_API_KEY,
        resampleFreq: "daily",
      },
    }
  );

  const lastPrice: number | null = response.data?.[0]?.close ?? null;

  await cli.set(
    redisStockKey(symbol),
    JSON.stringify(lastPrice),
    { EX: 3 * 60 * 60, }
  );

  return lastPrice;
}


// Stocks REST endpoint
app.get("/api/stocks", async (req: Request, res: Response): Promise<void> => {
    try {
      const SYMBOLS = ["AAPL", "TSLA", "MSFT", "GOOGL", "NVDA"];

      const results = await Promise.all(
        SYMBOLS.map(async (symbol) => {
          const cached = await cli.get(
            redisStockKey(symbol)
          );

          if (cached) {
            return {symbol, price: JSON.parse(cached),};
          }

          const price = await fetchAndStoreStock(symbol);
          return { symbol, price };
        })
      );

      const prices: Record<string, number | null> = {};

      results.forEach((item) => {
        prices[item.symbol] = item.price;
      });

      res.json(prices);
    } catch {
      res.status(500).json({
        error: "ERROR: Failed to fetch stocks",
      });
    }
  }
);



// Fetch and cache current Weather
async function fetchAndStoreWeather(city: string) {
  const openWeatherKey = process.env.WEATHER_API;
  const url = `https://api.openweathermap.org/data/2.5/weather?q=${city}&units=metric&appid=${openWeatherKey}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch weather for ${city}`);
  const data = await response.json();

  // Cache in Redis for 1 hour
  await cli.set(redisWeatherKey(city), JSON.stringify(data), { EX: 60 * 60 });
  console.log(`Stored weather in Redis for: ${city}`);
  return data;
}


// REST endpoint: /api/weather/:city
app.get("/api/weather/:city", async (req, res) => {
  const { city } = req.params;
  const key = redisWeatherKey(city);

  try {
    // Check Redis cache first
    const cached = await cli.get(key);
    if (cached) {
      console.log(`Served from Redis for: ${city}`);
      return res.json(JSON.parse(cached));
    }

    // Fetch from OpenWeather API
    const data = await fetchAndStoreWeather(city);
    res.json(data);
  } catch (err: unknown) {
    console.error(err);
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});



// Fetch and cache 5-day forecast
async function fetchAndStoreForecast(city: string) {
  const openWeatherKey = process.env.WEATHER_API;
  const url = `https://api.openweathermap.org/data/2.5/forecast?q=${city}&units=metric&appid=${openWeatherKey}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch forecast for ${city}`);
  const data = await response.json();

  // Store in Redis for 6 hours
  await cli.set(redisForecastKey(city), JSON.stringify(data), { EX: 6 * 60 * 60 });
  console.log(`Stored forecast in Redis for: ${city}`);
  return data;
}



// REST endpoint: /api/forecast/:city
app.get("/api/forecast/:city", async (req, res) => {
  const { city } = req.params;
  const key = redisForecastKey(city);

  try {
    // Check cache first
    const cached = await cli.get(key);
    if (cached) {
      console.log(`Served forecast from Redis for: ${city}`);
      return res.json(JSON.parse(cached));
    }

    // Fetch from OpenWeather and cache
    const data = await fetchAndStoreForecast(city);
    res.json(data);
  } catch (err: unknown) {
    console.error(err);
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});



// Fetch and store news for a given country/category
async function fetchAndStoreNews(country: string, category: string) {
  const url = `https://gnews.io/api/v4/top-headlines?category=${category}&lang=en&country=${country}&max=100&apikey=${newapikey}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed for ${country}-${category}`);
  const data = await response.json();
  await cli.set(redisNewsKey(country, category), JSON.stringify(data), { EX: 60 * 60 * 6 }); // expire after 6 hours
  console.log(`Stored: ${country}-${category}`);
  return data;
}



// REST endpoint for specific country + category
app.get("/api/news/:country/:category", async (req, res) => {
  const { country, category } = req.params;
  const key = redisNewsKey(country, category);

  try {
    const cached = await cli.get(key);
    if (cached) {
      console.log(`Served from Redis: ${country}-${category}`);
      return res.json(JSON.parse(cached));
    }

    // Otherwise fetch fresh and store
    const data = await fetchAndStoreNews(country, category);
    res.json(data);
  } catch (err: unknown) {
    console.error(err);
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});


// ===================== NEXAVIEW - CURATED NEWS =====================
app.get("/api/curnews", async (req, res) => {
  try {
    const term = (req.query.term as string) ?? "Singapore";
    const apikey = req.query.apikey as string | undefined;

    if (!apikey) {
      return res.status(400).json({ error: "Missing API key" });
    }

    const url = `https://newsapi.org/v2/everything?q=${term}&apiKey=${apikey}&lang=en`;
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("Error fetching news:", err);
    res.status(500).json({ error: "Failed to fetch news" });
  }
});



// ===================== NUVIN - GMAIL =====================
app.get("/api/gmail", async (req, res) => {
  try {
    const gmail = await getGmailService();

    const result = await gmail.users.messages.list({userId: "me", maxResults: 20,});

    const messages = result.data.messages ?? [];

    const emails = await Promise.all(
      messages.map(async (m) => {
        const msg = await gmail.users.messages.get({userId: "me", id: m.id!,});

        const headers = msg.data.payload?.headers ?? [];

        const subject = headers.find((h) => h.name === "Subject")?.value ?? "";

        const from = headers.find((h) => h.name === "From")?.value ?? "";

        return {id: m.id, from, subject,};
      })
    );

    res.json(emails);
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message === "TOKEN_EXPIRED" ||
        err.message === "NOT_AUTHENTICATED")
    ) {
      return res.status(401).json({
        error: "Authentication required.",
      });
    }

    console.error(err);

    res.status(500).json({
      error: "Failed to fetch emails.",
    });
  }
});



app.get("/api/gmail/login", async (req, res) => {
  try {
    const url = await getAuthUrl();
    res.redirect(url);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Unable to start Gmail authentication.",
    });
  }
});



app.get("/api/gmail/callback", async (req, res) => {
  try {
    const code = req.query.code as string;

    if (!code) {
      return res.status(400).json({
        error: "Missing authorization code.",
      });
    }

    await handleOAuthCallback(code);

    res.send("Gmail authentication successful. You may close this window.");
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Authentication failed.",
    });
  }
});



// ================= SERVER STARTUP =================
const PORT: number = Number(process.env.PORT ?? 5000);

app.listen(PORT, (): void => {
  console.log(`Server is currently running on port ${PORT}`);
});