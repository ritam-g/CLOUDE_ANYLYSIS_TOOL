/**
 * Extract images embedded in an Excel (.xlsx) file and send each one to
 * a free vision model on OpenRouter for analysis, matched up with the
 * row data next to it.
 *
 * Usage:
 *   node analyzeExcelImagesOpenRouter.js ./testing_market.xlsx "Daily Analysis"
 *
 * Requires: npm install exceljs openai dotenv
 * .env file: OPENROUTER_API_KEY=sk-or-v1-...
 *
 * Get a free key at: https://openrouter.ai/keys
 */

require("dotenv").config();
const ExcelJS = require("exceljs");
const OpenAI = require("openai");

// OpenRouter speaks the OpenAI API format, so we just point the base URL at it
const client = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

// List of free vision-capable models on OpenRouter, tried in order.
// If one is unavailable/rotated out, the script automatically falls back to the next.
// Check openrouter.ai/models (filter: Free + Vision) if ALL of these ever fail.
const FREE_VISION_MODELS = [
  "google/gemma-4-31b-it:free",
  "google/gemma-4-26b-a4b-it:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
];

async function extractImagesWithPositions(workbook, sheetName) {
  const worksheet = workbook.getWorksheet(sheetName);
  if (!worksheet) {
    throw new Error(`Sheet "${sheetName}" not found`);
  }

  const images = worksheet.getImages();

  const results = [];
  for (const img of images) {
    const imageId = img.imageId;
    const media = workbook.getImage(imageId); // { extension, buffer }

    const row = Math.round(img.range.tl.row) + 1;
    const col = Math.round(img.range.tl.col) + 1;

    const ext = media.extension === "jpg" ? "jpeg" : media.extension;

    results.push({
      row,
      col,
      buffer: media.buffer,
      mimeType: `image/${ext}`,
    });
  }
  return results;
}

function getRowText(worksheet, rowNum) {
  const row = worksheet.getRow(rowNum);
  const values = [];
  row.eachCell({ includeEmpty: false }, (cell) => {
    values.push(String(cell.value));
  });
  return values.join(" | ");
}

async function analyzeImageWithOpenRouter(buffer, mimeType, contextText) {
  const base64Data = Buffer.from(buffer).toString("base64");
  const dataUrl = `data:${mimeType};base64,${base64Data}`;

  const prompt =
    `This is a trading chart screenshot. Row context: ${contextText}\n\n` +
    "Analyze this chart: trend direction, key support/resistance levels, " +
    "any chart patterns visible, and a brief bias (bullish/bearish/neutral).";

  let lastError;

  for (const model of FREE_VISION_MODELS) {
    try {
      console.log(`  Trying model: ${model}...`);

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

      console.log(`  Success with: ${model}`);
      return response.choices[0].message.content;
    } catch (err) {
      const is404 = err.status === 404 || (err.message || "").includes("404");
      const isRateLimit = err.status === 429 || (err.message || "").includes("429");

      if (is404) {
        console.log(`  ${model} unavailable, trying next...`);
      } else if (isRateLimit) {
        console.log(`  ${model} rate limited, trying next...`);
      } else {
        console.log(`  ${model} failed: ${err.message}, trying next...`);
      }

      lastError = err;
      continue;
    }
  }

  throw new Error(`All free models failed. Last error: ${lastError.message}`);
}

async function main() {
  const [, , xlsxPath, sheetName] = process.argv;

  if (!xlsxPath || !sheetName) {
    console.log('Usage: node analyzeExcelImagesOpenRouter.js <file.xlsx> "<sheet name>"');
    process.exit(1);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(xlsxPath);

  const worksheet = workbook.getWorksheet(sheetName);
  const images = await extractImagesWithPositions(workbook, sheetName);

  if (images.length === 0) {
    console.log(`No embedded images found on sheet "${sheetName}".`);
    return;
  }

  for (const img of images) {
    const context = getRowText(worksheet, img.row);
    console.log(`\n--- Image at row ${img.row} ---`);
    console.log(`Row data: ${context}`);
    console.log("Analyzing with OpenRouter...");

    const analysis = await analyzeImageWithOpenRouter(img.buffer, img.mimeType, context);
    console.log(`Analysis:\n${analysis}`);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});