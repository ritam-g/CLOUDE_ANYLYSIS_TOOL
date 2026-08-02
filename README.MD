
# Excel Chart Image Analysis — What We Tried & Why We Landed Here

## The Problem

Excel sheet (`testing_market.xlsx`) has multiple tabs (Daily Analysis, Trade Journal, Strength Board) with trading data, and some rows have **chart screenshots pasted directly into cells** (e.g. the `xauusd` row). Goal: get an AI to read and analyze those embedded chart images automatically, alongside the row's text data.

---

## Attempt 1: Claude.ai's Google Drive Connector

**What we tried:** Connect Google Drive to Claude, open the Excel file directly in chat.

**Drawback:**

- The Drive connector extracts **text only** — Sheets are pulled in as CSV. Any image embedded in a cell is silently dropped before Claude ever sees the file.
- This isn't a bug or misconfiguration — it's a hard architectural limit of how the connector's data pipeline works.

**Verdict:** ❌ Dead end. No way to get embedded images through this path, regardless of settings.

---

## Attempt 2: Sharing Google Drive Image Links Directly

**What we tried:** Upload the chart image to Google Drive, share the link, paste the link into the sheet / chat for Claude to fetch and view.

**Drawback:**

- A Drive "share" link (`drive.google.com/file/d/.../view`) resolves to an **HTML viewer/sign-in page**, not the raw image — so fetching it just returns a webpage, not a picture.
- The "direct download" link format (`drive.google.com/uc?export=view&id=...`) is **blocked by Google's own `robots.txt`** for automated fetching — this is Google actively preventing bots from pulling files this way.

**Verdict:** ❌ Dead end. No Drive link format works for automated image fetching.

---

## Attempt 3: Third-Party Image Host Links (ImgBB / Imgur)

**What we tried:** Upload the same image to ImgBB, get a direct image URL, paste that into the sheet for Claude to fetch.

**Drawback:**

- Unlike Drive, the host page and direct link **were** reachable.
- But Claude's `web_fetch` tool is built to read **web pages / text content**, not to pull in raw image bytes as a viewable image. The fetch technically succeeded, but the image was never actually "seen."

**Verdict:** ❌ Dead end — a different failure point than Drive, but same outcome. **Link-based image analysis has a hard ceiling in the claude.ai chat interface, no matter which host you use.**

---

## Attempt 4: Claude API — Direct Image Upload (Backend Script)

**What we tried:** Write a script (Python, then Node.js) that:

1. Opens the `.xlsx` file directly (it's just a ZIP internally)
2. Extracts the embedded image bytes from the cell
3. Base64-encodes them
4. Sends them to the **Claude API** as a true image upload (not a link)

**Result:** ✅ This technically worked — the image was successfully sent and would have been analyzed.

**Drawback:**

- The Claude API is **pay-as-you-go only**. There's a small one-time trial credit for new accounts, but no ongoing free tier.
- Hit: `"Your credit balance is too low to access the Anthropic API."`

**Verdict:** ⚠️ Works, but costs money. Good long-term option if willing to pay (cheap per-call), but not free.

---

## Attempt 5: Google Gemini API — Same Direct-Upload Script

**What we tried:** Same script logic, swapped Claude's SDK for `@google/generative-ai`, using `gemini-2.0-flash`.

**Result:** Hit a `429 Too Many Requests` error immediately.

**Drawback:**

- Error showed `"limit": 0` for the free tier on that model/project — meaning the account had **zero allocated free quota**, not just a rate limit.
- Likely causes: regional restrictions, an API not fully enabled on the Google Cloud project, or that specific model no longer carrying free quota for this account type.
- Even with retry-with-backoff logic added, retries can't fix a `limit: 0` — that's a permanent block, not a temporary throttle.

**Verdict:** ❌ Free tier exists on paper but was inaccessible for this account/region/model combination.

---

## Attempt 6: OpenRouter — Free-Tier Vision Models ✅ (Final Solution)

**What we tried:** Same script logic again, pointed at OpenRouter (`openrouter.ai`) instead — a service that proxies multiple AI providers and offers several vision-capable models with a genuine `:free` tag (no billing required at all).

**Drawback encountered along the way:**

- The first free model name tried (`google/gemini-2.0-flash-exp:free`) had already been **rotated out** of OpenRouter's free lineup — 404 error.
- **Fix:** Rebuilt the script to try a **list of free vision models in sequence**, automatically falling back to the next one if any single model is unavailable or rate-limited.

**Result:** ✅ **Fully worked.** Using `google/gemma-4-31b-it:free`, the script:

- Extracted the embedded chart image from the Excel file
- Sent it directly to a vision-capable model
- Got back a complete, accurate technical analysis (trend, support/resistance, chart pattern, bias) — including a real observational detail (recognizing an inverted price axis on the chart)

---

## Why OpenRouter (Free Models) Beats Claude API and Gemini API Here

| Factor                             | Claude API                          | Gemini API                                                     | OpenRouter (Free)                                         |
| ---------------------------------- | ----------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------- |
| **Cost**                     | Pay-as-you-go, no ongoing free tier | "Free tier" exists but inaccessible in practice (`limit: 0`) | Genuinely $0, no billing required                         |
| **Setup friction**           | API key + billing required          | API key + quota is inconsistent by region/project              | API key only, no card                                     |
| **Reliability once working** | High (once paid)                    | Blocked by quota before it could even run                      | Works, with model rotation as the only caveat             |
| **Fallback handling**        | N/A (works or doesn't)              | N/A (hard block)                                               | Script tries multiple free models automatically           |
| **Long-term risk**           | None (stable paid pricing)          | Free tier eligibility unclear/inconsistent                     | Free models rotate — needs occasional model-name updates |

**Bottom line reasoning:**

- Claude API is the most *reliable* long-term option, but it costs real money from the first call — not what was asked for.
- Gemini's free tier looks appealing on paper but hit an **actual hard wall** (`limit: 0`) for this account — unusable as-is without further account/region troubleshooting.
- OpenRouter's free models delivered a **complete, working, zero-cost result** — the only real drawback is that free model availability shifts over time, which the script now handles automatically via fallback list.

**For a "must be free" requirement, OpenRouter is currently the only approach in this list that actually delivers real results at zero cost, with acceptable ongoing maintenance (occasionally updating the model list if one gets rotated out).**

---

## Final Working Pipeline (For Reference)

```
Excel file (.xlsx)
   → ExcelJS reads embedded image bytes directly from the file
   → Row's text data (Pair, Bias, Notes, etc.) pulled alongside it
   → Image base64-encoded
   → Sent to OpenRouter's free vision model (with automatic fallback across 3 models)
   → Returns full chart analysis: trend, support/resistance, pattern, bias
```

**Maintenance note:** If all fallback models in the script ever fail at once, check `openrouter.ai/models`, filter by **Free + Vision**, and update the `FREE_VISION_MODELS` list in the script with currently active model IDs.
