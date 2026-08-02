/**
 * server.js
 * Reads testing_market.xlsx automatically from this same folder,
 * extracts embedded images, sends them to OpenRouter's free vision
 * models, and serves results to the frontend via one API endpoint.
 *
 * Usage:
 *   npm install express exceljs openai dotenv cors
 *   node server.js
 *   Then open http://localhost:3000 in your browser and click Analyze.
 *
 * .env file needed: OPENROUTER_API_KEY=sk-or-v1-...
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const ExcelJS = require("exceljs");
const OpenAI = require("openai");

const app = express();
const PORT = 3000;

// ---- CONFIG: change these if your file/sheet names differ ----
const EXCEL_FILENAME = "testing_market.xlsx";
const SHEET_NAME = "Daily Analysis";
// ----------------------------------------------------------------

const client = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

const FREE_VISION_MODELS = [
  "google/gemma-4-31b-it:free",
  "google/gemma-4-26b-a4b-it:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
];

app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

async function extractImagesWithPositions(workbook, sheetName, logs) {
  const worksheet = workbook.getWorksheet(sheetName);
  if (!worksheet) throw new Error(`Sheet "${sheetName}" not found`);

  const images = worksheet.getImages();
  logs.push(`Found ${images.length} embedded image(s) on sheet "${sheetName}"`);

  const results = [];

  for (const img of images) {
    const media = workbook.getImage(img.imageId);
    const row = Math.round(img.range.tl.row) + 1;
    const ext = media.extension === "jpg" ? "jpeg" : media.extension;

    logs.push(`  → Image at row ${row} (${ext}, ${(media.buffer.length / 1024).toFixed(1)} KB)`);

    results.push({
      row,
      buffer: media.buffer,
      mimeType: `image/${ext}`,
    });
  }
  return results;
}

function getRowText(worksheet, rowNum) {
  const row = worksheet.getRow(rowNum);
  const values = [];
  row.eachCell({ includeEmpty: false }, (cell) => values.push(String(cell.value)));
  return values.join(" | ");
}

async function analyzeImageWithOpenRouter(buffer, mimeType, contextText, logs) {
  const base64Data = Buffer.from(buffer).toString("base64");
  const dataUrl = `data:${mimeType};base64,${base64Data}`;

  const prompt =
    `This is a trading chart screenshot. Row context: ${contextText}\n\n` +
    "Analyze this chart: trend direction, key support/resistance levels, " +
    "any chart patterns visible, and a brief bias (bullish/bearish/neutral). " +
    "Format your answer with clear short sections.";

  let lastError;

  for (const model of FREE_VISION_MODELS) {
    try {
      logs.push(`  Trying model: ${model} ...`);
      const response = await client.chat.completions.create({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      });
      logs.push(`  ✓ Success with ${model}`);
      return { text: response.choices[0].message.content, modelUsed: model };
    } catch (err) {
      const is404 = err.status === 404 || (err.message || "").includes("404");
      const isRateLimit = err.status === 429 || (err.message || "").includes("429");
      const reason = is404 ? "unavailable (404)" : isRateLimit ? "rate limited (429)" : err.message;
      logs.push(`  ✗ ${model} failed — ${reason}, trying next...`);
      lastError = err;
      continue;
    }
  }
  throw new Error(`All free models failed. Last error: ${lastError.message}`);
}

// The single endpoint the frontend button calls
app.get("/analyze", async (req, res) => {
  const logs = [];
  try {
    logs.push(`Reading file: ${EXCEL_FILENAME}`);
    const filePath = path.join(__dirname, EXCEL_FILENAME);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    logs.push(`File loaded successfully`);

    logs.push(`Opening sheet: "${SHEET_NAME}"`);
    const worksheet = workbook.getWorksheet(SHEET_NAME);
    const images = await extractImagesWithPositions(workbook, SHEET_NAME, logs);

    if (images.length === 0) {
      logs.push(`No embedded images found — nothing to analyze`);
      return res.json({ success: true, results: [], logs, message: "No embedded images found." });
    }

    const results = [];
    for (const img of images) {
      const context = getRowText(worksheet, img.row);
      logs.push(`Analyzing row ${img.row} — context: "${context}"`);
      const { text, modelUsed } = await analyzeImageWithOpenRouter(img.buffer, img.mimeType, context, logs);
      results.push({ row: img.row, context, analysis: text, modelUsed });
    }

    logs.push(`Done — ${results.length} image(s) analyzed`);
    res.json({ success: true, results, logs });
  } catch (err) {
    logs.push(`ERROR: ${err.message}`);
    res.status(500).json({ success: false, error: err.message, logs });
  }
});

app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
  console.log(`Reading file: ${EXCEL_FILENAME} | Sheet: ${SHEET_NAME}`);
});