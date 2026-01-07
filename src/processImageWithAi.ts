// processImageWithAi.ts
import sharp from "sharp";
import crypto from "crypto";
import axios from "axios";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Extrai validade direto via modelo multimodal (Responses API).
 * - NÃO usa OCR.
 * - Requer: OPENAI_API_KEY, LLM_MULTIMODAL_MODEL, AWS_REGION, MY_BUCKET
 *
 * Retorna YYYY-MM-DD ou null.
 */

const OPENAI_API_URL = "https://api.openai.com/v1/responses";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MULTIMODAL_MODEL = process.env.LLM_MULTIMODAL_MODEL;

export async function getValidadeFromImageAI(imageBuffer: Buffer): Promise<string | null> {
  try {
    // optimize image
    const optimized = await sharp(imageBuffer)
      .rotate()
      .resize({ width: 1200, withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

   

    // upload to S3 for signed URL
    let imageUrl: string;
    try {
      imageUrl = await uploadBufferAndGetUrl(optimized);

    } catch (uErr) {
      console.error("[getValidadeFromImageAI] upload failed:", uErr);
      return null;
    }

    if (!OPENAI_API_KEY || !MULTIMODAL_MODEL) {
      console.error("[getValidadeFromImageAI] OPENAI_API_KEY or MULTIMODAL_MODEL not set");
      return null;
    }

    // strict system instruction
    const systemPrompt = `You are an assistant that only extracts expiration dates from an image.
Respond ONLY with a single value in ISO format: YYYY-MM-DD or null (without quotes, no explanation).
If there is a date in day/month/year format, convert it to YYYY-MM-DD.
If there is only a month/year like 10/26, interpret as MM/YY and convert to the last day of that month in YYYY-MM-DD.
Do NOT invent dates; if you are uncertain, respond null.`;

    // payload format with input_text / input_image (common for Responses multimodal)
    const body = {
      model: MULTIMODAL_MODEL,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: systemPrompt }]
        },
        {
          role: "user",
          content: [
            { type: "input_text", text: "Extract expiration date from this image (return only YYYY-MM-DD or null):" },
            { type: "input_image", image_url: imageUrl }
          ]
        }
      ],
      max_output_tokens: 150
    };

    // axios request
    const resp = await axios.post(OPENAI_API_URL, body, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      timeout: 30_000,
    });

    const rawRes = resp.data as unknown;
    const rawText = extractTextFromResponses(rawRes);
    

    if (!rawText) return null;

    // prefer ISO if present
    const isoMatch = rawText.match(/\d{4}-\d{2}-\d{2}/);
    if (isoMatch && isValidISODate(isoMatch[0])) return isoMatch[0];

    if (/^null$/i.test(rawText)) return null;

    // try extract dd/mm/yy, mm/yy etc.
    const parsed = extractDateFromText(rawText);
    if (parsed) return parsed;

    return null;
  } catch (err: any) {
    // improved error logging for troubleshooting the API response body
    if (err?.response?.data) {
      try {
        console.error("[getValidadeFromImageAI] OpenAI error response:", JSON.stringify(err.response.data, null, 2));
      } catch {
        console.error("[getValidadeFromImageAI] OpenAI error response (non-json):", err.response.data);
      }
    } else {
      console.error("[getValidadeFromImageAI] error:", err?.message ?? err);
    }
    return null;
  }
}

/* ------------------ Helpers top-level ------------------ */

function isRecord(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function isString(v: unknown): v is string {
  return typeof v === "string";
}
function isArray(v: unknown): v is any[] {
  return Array.isArray(v);
}

/** Extract textual content from various Responses API shapes safely */
export function extractTextFromResponses(res: unknown): string | null {
  if (!isRecord(res)) return null;

  // 1) new Responses shape: res.output -> [{ content: [{ type, text }] }]
  const output = (res as any).output;
  if (isArray(output) && output.length > 0) {
    for (const out of output) {
      if (isRecord(out) && isArray(out.content)) {
        for (const c of out.content) {
          if (isRecord(c) && isString(c.text) && c.text.trim()) return c.text.trim();
          if (isString(c) && c.trim()) return c.trim();
        }
      } else if (isString(out) && out.trim()) {
        return out.trim();
      }
    }
  }

  // 2) fallback: output_text
  if (isString((res as any).output_text) && (res as any).output_text.trim()) {
    return (res as any).output_text.trim();
  }

  // 3) fallback: choices style
  const choices = (res as any).choices;
  if (isArray(choices) && choices.length > 0) {
    const c0 = choices[0];
    if (isRecord(c0) && isString(c0.text) && c0.text.trim()) return c0.text.trim();
    if (isRecord(c0) && isRecord(c0.message) && isString(c0.message.content) && c0.message.content.trim()) return c0.message.content.trim();
  }

  return null;
}

/* ---------- S3 upload ---------- */
async function uploadBufferAndGetUrl(buffer: Buffer): Promise<string> {
  const region = process.env.AWS_REGION;
  const bucket = process.env.MY_BUCKET;
  if (!region || !bucket) throw new Error("AWS_REGION and MY_BUCKET must be set in env");

  const s3 = new S3Client({ region });

  const key = `validades/${Date.now()}-${crypto.randomBytes(6).toString("hex")}.jpg`;
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: "image/jpeg" }));
  const getCmd = new GetObjectCommand({ Bucket: bucket, Key: key });
  const readUrl = await getSignedUrl(s3, getCmd, { expiresIn: 60 * 5 });
  return readUrl;
}

/* ---------- Date parsing helpers ---------- */

export function isValidISODate(s: string) {
  const parts = s.split("-");
  if (parts.length !== 3) return false;
  const [y, m, d] = parts.map(Number);
  if (!y || !m || !d) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Extract and normalize common date patterns to YYYY-MM-DD */
export function extractDateFromText(text: string): string | null {
  if (!text) return null;
  const t = text.replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();

  // dd/mm/yyyy or dd-mm-yyyy (2 or 4 year digits)
  let m = t.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
  if (m) {
    let day = Number(m[1]), month = Number(m[2]), year = Number(m[3]);
    if (year < 100) year += 2000;
    const iso = toISOIfValid(year, month, day);
    if (iso) return iso;
  }

  // mm/yy or mm/yyyy -> last day of month
  m = t.match(/\b(\d{1,2})[\/](\d{2,4})\b/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a >= 1 && a <= 12) {
      const year = b < 100 ? 2000 + b : b;
      const month = a;
      const last = new Date(year, month, 0).getDate();
      return toISOIfValid(year, month, last);
    }
  }

  // yyyy-mm-dd
  m = t.match(/\b(20\d{2}|\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\b/);
  if (m) {
    const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
    const iso = toISOIfValid(year, month, day);
    if (iso) return iso;
  }

  // dd MMM yyyy (month names pt/en)
  m = t.match(/\b(\d{1,2})\s+([A-Za-zçÇ]+)\s+(\d{4})\b/);
  if (m) {
    const day = Number(m[1]), monthRaw = m[2].toLowerCase(), year = Number(m[3]);
    const monthsMap: Record<string, number> = {
      jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,
      janeiro:1,fevereiro:2,março:3,abril:4,maio:5,junho:6,julho:7,agosto:8,setembro:9,outubro:10,novembro:11,dezembro:12
    };
    const month = monthsMap[monthRaw.slice(0,3)] ?? monthsMap[monthRaw];
    if (month) {
      const iso = toISOIfValid(year, month, day);
      if (iso) return iso;
    }
  }

  return null;
}

export function toISOIfValid(year: number, month: number, day: number): string | null {
  if (!year || !month || !day) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day) {
    const mm = String(month).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    return `${year}-${mm}-${dd}`;
  }
  return null;
}
