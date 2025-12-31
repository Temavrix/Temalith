// server.js
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import axios from "axios";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { MongoClient, ObjectId } from "mongodb";
import { createClient } from "redis";
import dotenv from "dotenv";
dotenv.config({ path: "config.env" });


const app = express();
app.use(cors());
app.use(express.json());

const TIINGO_API_KEY = process.env.TIINGO_API_KEY;
const redisUrl = process.env.REDIS_URL;

// Redis client
const cli = createClient({ url: redisUrl });
cli.on("error", (err) => console.error("Redis error:", err));

(async () => {
  try {
    await cli.connect();
    console.log("Redis is connected");
  } catch (err) {
    console.error("ERROR: Redis connection failed:", err.message);
  }
})();

// Redis key helper
const redisStockKey = (symbol) => `stock:${symbol.toUpperCase()}`;

// Fetch from Tiingo and store in Redis for 2 hours
async function fetchAndStoreStock(symbol) {
  const response = await axios.get(
    `https://api.tiingo.com/tiingo/daily/${symbol}/prices`,
    {
      params: { token: TIINGO_API_KEY, resampleFreq: "daily" },
    }
  );

  const lastPrice = response.data[0]?.close ?? null;

  // Cache in Redis for 2 hours
  await cli.set(redisStockKey(symbol), JSON.stringify(lastPrice), { EX: 3 * 60 * 60 });
  console.log(`Stored stock in Redis for: ${symbol}`);

  return lastPrice;
}

// REST endpoint
app.get("/api/stocks", async (req, res) => {
  try {
    const SYMBOLS = ["AAPL", "TSLA", "MSFT", "GOOGL", "NVDA"];
    const results = await Promise.all(
      SYMBOLS.map(async (symbol) => {
        // Check Redis cache first
        const cached = await cli.get(redisStockKey(symbol));
        if (cached) {
          console.log(`Served from Redis: ${symbol}`);
          return { symbol, price: JSON.parse(cached) };
        }

        // Fetch from Tiingo
        const price = await fetchAndStoreStock(symbol);
        return { symbol, price };
      })
    );

    const prices = {};
    results.forEach((r) => (prices[r.symbol] = r.price));

    res.json(prices);
  } catch (err) {
    res.status(500).json({ error: "ERROR: Failed to fetch stocks" });
  }
});

// ================= CONNECT DB =================
async function connectDB() {
    if (!client || !client.topology?.isConnected()) {
        client = new MongoClient(process.env.ATLAS_URI);
        await client.connect();
        db = client.db("metodo");
        console.log("Connected to MongoDB");

        try {
            await db.collection("users").createIndex({ email: 1 }, { unique: true });
            console.log("Email index ensured (unique)");
        } catch (err) {
            console.error("Index creation error:", err.message);
        }
    }
    return db;
}

// ================= MIDDLEWARE =================
function authMiddleware(req, res, next) {
    const token = req.headers["authorization"];
    if (!token) return res.status(401).json({ msg: "No token, authorization denied" });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded; // contains id
        next();
    } catch (err) {
        return res.status(401).json({ msg: "Token is not valid" });
    }
}


// ===================== NEXAVIEW =====================
const newapikey = process.env.GNEWS_API_KEY;

const rediswea = (city) => `weather:${city.toLowerCase()}`;

async function fetchAndStoreWeather(city) {
  const openWeatherKey = process.env.WEATHER_API;
  const url = `https://api.openweathermap.org/data/2.5/weather?q=${city}&units=metric&appid=${openWeatherKey}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch weather for ${city}`);

  const data = await response.json();

  // Cache in Redis for 1 hour
  await cli.set(rediswea(city), JSON.stringify(data), { EX: 60 * 60 });
  console.log(`Stored weather in Redis for: ${city}`);

  return data;
}

// REST endpoint: /api/weather/:city
app.get("/api/weather/:city", async (req, res) => {
  const { city } = req.params;
  const key = rediswea(city);

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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});



const redisForecastKey = (city) => `forecast:${city.toLowerCase()}`;

// Fetch and cache 5-day forecast
async function fetchAndStoreForecast(city) {
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});






// Available countries and categories
const countries = ["us", "sg", "in"];
const categories = ["general", "nation", "business", "technology", "entertainment"];

// Helper: build Redis key
const redisKey = (country, category) => `gnews:${country}:${category}`;

// Fetch and store news for a given country/category
async function fetchAndStoreNews(country, category) {
  const url = `https://gnews.io/api/v4/top-headlines?category=${category}&lang=en&country=${country}&max=100&apikey=${newapikey}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed for ${country}-${category}`);
  const data = await response.json();
  await cli.set(redisKey(country, category), JSON.stringify(data), { EX: 60 * 60 * 6 }); // expire after 6 hours
  console.log(`Stored: ${country}-${category}`);
  return data;
}

// Preload all news combinations (optional)
async function preloadAllNews() {
  console.log("Preloading news data...");
  for (const country of countries) {
    for (const category of categories) {
      try {
        await fetchAndStoreNews(country, category);
      } catch (err) {
        console.error(`Failed: ${country}-${category}`, err.message);
      }
    }
  }
  console.log("Preloading complete.");
}

// REST endpoint for specific country + category
app.get("/api/news/:country/:category", async (req, res) => {
  const { country, category } = req.params;
  const key = redisKey(country, category);

  try {
    const cached = await cli.get(key);
    if (cached) {
      console.log(`Served from Redis: ${country}-${category}`);
      return res.json(JSON.parse(cached));
    }

    // Otherwise fetch fresh and store
    const data = await fetchAndStoreNews(country, category);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Schedule-like backup (optional call)
app.get("/backup", async (req, res) => {
  await preloadAllNews();
  res.send("All country-category data backed up!");
});


app.get("/api/curnews", async (req, res) => {
  try {
    const { term = "Singapore", apikey } = req.query;

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

// ===================== REGISTER =====================
app.post("/api/register", async (req, res) => {
    try {
        const { email, password } = req.body;
        const db = await connectDB();

        const existingUser = await db.collection("users").findOne({ email });
        if (existingUser) return res.status(400).json({ msg: "User already exists" });

        const hashedPassword = await bcrypt.hash(password, 10);
        await db.collection("users").insertOne({ email, password: hashedPassword });

        res.json({ msg: "Registered successfully" });
    } catch (err) {
        console.error("Registration Error:", err.message);
        res.status(500).json({ msg: "Server error" });
    }
});

// ===================== LOGIN =====================
app.post("/api/login", async (req, res) => {
    try {
        const { email, password } = req.body;
        const db = await connectDB();
        const user = await db.collection("users").findOne({ email });

        if (!user) return res.status(400).json({ msg: "ERROR: User not found" });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ msg: "ERROR: Invalid credentials" });

        const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "1h" });
        res.json({ token });
    } catch (err) {
        console.error("Login Error:", err.message);
        res.status(500).json({ msg: "Server error" });
    }
});

// ===================== TASKS =====================

// Get tasks
app.get("/api/tasks", authMiddleware, async (req, res) => {
    try {
        const db = await connectDB();
        const tasks = await db.collection("tasks")
            .find({ userId: new ObjectId(req.user.id) })
            .toArray();
        res.json(tasks);
    } catch (err) {
        console.error("Get Tasks Error:", err.message);
        res.status(500).json({ msg: "Server error" });
    }
});

// Add a task
app.post("/api/tasks", authMiddleware, async (req, res) => {
    try {
        const { title } = req.body;
        const db = await connectDB();
        const newTask = {
            userId: new ObjectId(req.user.id),
            title,
            createdAt: new Date(),
            done: false,
            completedAt: null
        };
        await db.collection("tasks").insertOne(newTask);
        res.json({ msg: "Task added" });
    } catch (err) {
        console.error("Add Task Error:", err.message);
        res.status(500).json({ msg: "Server error" });
    }
});

// Toggle task done/undone
app.put("/api/tasks/:id/done", authMiddleware, async (req, res) => {
    try {
        const db = await connectDB();
        const task = await db.collection("tasks").findOne({ 
            _id: new ObjectId(req.params.id),
            userId: new ObjectId(req.user.id)
        });

        if (!task) return res.status(404).json({ msg: "Task not found" });

        const newDone = !task.done;

        const updated = await db.collection("tasks").findOneAndUpdate(
            { _id: new ObjectId(req.params.id), userId: new ObjectId(req.user.id) },
            { 
                $set: { 
                    done: newDone, 
                    completedAt: newDone ? new Date() : null 
                }
            },
            { returnDocument: "after" }
        );

        res.json(updated.value);
    } catch (err) {
        console.error("Toggle Done Error:", err.message);
        res.status(500).json({ msg: "Server error" });
    }
});

// Delete task
app.delete("/api/tasks/:id", authMiddleware, async (req, res) => {
    try {
        const db = await connectDB();
        await db.collection("tasks").deleteOne({ 
            _id: new ObjectId(req.params.id), 
            userId: new ObjectId(req.user.id) 
        });
        res.json({ msg: "Task deleted" });
    } catch (err) {
        console.error("Delete Task Error:", err.message);
        res.status(500).json({ msg: "Server error" });
    }
});

// ===================== NOTES =====================

// Get all notes
app.get("/api/notes", authMiddleware, async (req, res) => {
    try {
        const db = await connectDB();
        const notes = await db.collection("notes")
            .find({ userId: new ObjectId(req.user.id) })
            .sort({ createdAt: -1 })
            .toArray();
        res.json(notes);
    } catch (err) {
        console.error("Get Notes Error:", err.message);
        res.status(500).json({ msg: "Server error" });
    }
});

// Add a note
app.post("/api/notes", authMiddleware, async (req, res) => {
  const { title } = req.body;
  const newNote = {
    userId: new ObjectId(req.user.id),
    title: title || "Untitled Note",
    content: "",
    createdAt: new Date(),
  };
  await db.collection("notes").insertOne(newNote);
  res.json(newNote);
});


// Get single note by ID
app.get("/api/notes/:id", authMiddleware, async (req, res) => {
    try {
        const db = await connectDB();
        const note = await db.collection("notes").findOne({ 
            _id: new ObjectId(req.params.id),
            userId: new ObjectId(req.user.id)
        });
        if (!note) return res.status(404).json({ msg: "Note not found ❌" });
        res.json(note);
    } catch (err) {
        console.error("Get Note Error:", err.message);
        res.status(500).json({ msg: "Server error" });
    }
});

// Update note (title & content)
app.put("/api/notes/:id", authMiddleware, async (req, res) => {
    try {
        const { title, content } = req.body;
        const db = await connectDB();
        const updated = await db.collection("notes").findOneAndUpdate(
            { _id: new ObjectId(req.params.id), userId: new ObjectId(req.user.id) },
            { $set: { title, content } },
            { returnDocument: "after" }
        );
        res.json(updated.value);
    } catch (err) {
        console.error("Update Note Error:", err.message);
        res.status(500).json({ msg: "Server error" });
    }
});

// delete note
app.delete("/api/notes/:id", authMiddleware, async (req, res) => {
    try {
        const db = await connectDB();
        const result = await db.collection("notes").deleteOne({
            _id: new ObjectId(req.params.id),
            userId: new ObjectId(req.user.id),
        });

        if (result.deletedCount === 0) {
            return res.status(404).json({ msg: "Note not found ❌" });
        }

        res.json({ msg: "Note deleted ✅" });
    } catch (err) {
        console.error("Delete Note Error:", err.message);
        res.status(500).json({ msg: "Server error" });
    }
});



// ================= START SERVER =================
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server is currently running on port ${PORT}`);
});
