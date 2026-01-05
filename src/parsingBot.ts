// parsingBot.ts (REFATORADO — IA cuida de tudo)
import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";

/* ===================== Types ===================== */

export type ParsedReminder = {
  produto: string | null;
  validade: string | null; // YYYY-MM-DD or null
  diasAntes: number | null;
};

/* ===================== Config / Prompt ===================== */

const TIMEZONE = "America/Sao_Paulo";


const SYSTEM_PROMPT =
  'Retorne SOMENTE JSON com as chaves: {\"produto\":string|null,\"validade\":\"YYYY-MM-DD\"|null,\"diasAntes\":number|null}. ' +
  'Use YYYY-MM-DD quando possível; ao inferir ano, escolha o próximo ano possível no timezone America/Sao_Paulo. ' +
  'Aceite datas em pt-BR (ex.: 25/01, 25/01/26, 25 de janeiro). ' +
  'Se não houver informação suficiente para um campo, retorne null.';

/* ===================== Helpers ===================== */

function nowInSaoPaulo(): Date {
  const s = new Date().toLocaleString("en-US", { timeZone: TIMEZONE });
  return new Date(s);
}
function pad(n: number) { return String(n).padStart(2, "0"); }

function cleanModelOutput(text: string): string {
  if (!text) return text;
  let r = text.trim();
  // remover fences de código
  r = r.replace(/```(?:\w*\n)?([\s\S]*?)```/g, (_m, p1) => p1.trim());
  r = r.replace(/`([^`]+)`/g, "$1");
  // remover prefixos comuns tipo "Resposta:" ou "Output -"
  r = r.replace(/^[A-Za-zÀ-ÿ0-9\s\(\)\-]{1,60}[:\-–—]\s*/i, "").trim();
  return r;
}

function extractJson(text: string): string | null {
  if (!text) return null;
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
    } else {
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/* ===================== Date Normalization (usada só para validar/consertar) ===================== */

function normalizeDate(input?: string | null): string | null {
  if (!input) return null;
  const t = input.trim();

  // já em ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;

  // DD/MM/YYYY
  let m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const d = Number(m[1]), mon = Number(m[2]), y = Number(m[3]);
    if (isValidDateParts(y, mon, d)) return `${y}-${pad(mon)}-${pad(d)}`;
    return null;
  }

  // DD/MM/YY
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (m) {
    const d = Number(m[1]), mon = Number(m[2]), y = 2000 + Number(m[3]);
    if (isValidDateParts(y, mon, d)) return `${y}-${pad(mon)}-${pad(d)}`;
    return null;
  }

  // DD/MM (inferir ano)
  m = t.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) {
    const d = Number(m[1]), mon = Number(m[2]);
    return inferYearThenFormat(d, mon);
  }

  // formatos em pt-BR "25 de janeiro" ou "25 janeiro 2026"
  const months: { [k: string]: number } = {
    janeiro:1, jan:1, fevereiro:2, fev:2, marco:3, março:3, mar:3,
    abril:4, abr:4, maio:5, mai:5, junho:6, jun:6, julho:7, jul:7,
    agosto:8, ago:8, setembro:9, set:9, outubro:10, out:10,
    novembro:11, nov:11, dezembro:12, dez:12
  };

  const mt = t.match(/^\s*(\d{1,2})(?:\s*de\s*|\s+)([^\d]+?)(?:\s+(\d{4}))?\s*$/i);
  if (mt) {
    const d = Number(mt[1]);
    let monthWord = (mt[2] || "").toLowerCase().trim();
    monthWord = monthWord.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    let mon = months[monthWord] ?? months[monthWord.slice(0,3)];
    if (!mon) {
      mon = months[monthWord.split(/\s+/)[0]] ?? months[monthWord.slice(0,3)];
    }
    if (!mon) return null;
    const yearFromText = mt[3] ? Number(mt[3]) : null;
    if (yearFromText) {
      if (isValidDateParts(yearFromText, mon, d)) return `${yearFromText}-${pad(mon)}-${pad(d)}`;
      return null;
    }
    return inferYearThenFormat(d, mon);
  }

  return null;
}

function isValidDateParts(y: number, mon: number, d: number): boolean {
  if (mon < 1 || mon > 12 || d < 1) return false;
  const mdays = [31, (isLeap(y) ? 29 : 28), 31,30,31,30,31,31,30,31,30,31];
  return d <= mdays[mon - 1];
}
function isLeap(y: number) { return (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0); }

function inferYearThenFormat(day: number, month: number): string | null {
  const now = nowInSaoPaulo();
  let year = now.getFullYear();
  const candidate = new Date(year, month - 1, day);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (candidate < today) year++;
  if (!isValidDateParts(year, month, day)) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/* ===================== Main: requestParsingBot (IA cuida de tudo) ===================== */

export async function requestParsingBot(prompt: string): Promise<ParsedReminder | null> {
  if (!prompt || prompt.trim().length < 2) return null;

  // evitar respostas triviais de confirmação
  if (/^\s*(sim|s|ok|okay|yes|no|não|nao|cancelar)\s*$/i.test(prompt)) return null;

  const model = new ChatOpenAI({
    modelName: "gpt-5-mini",
    maxTokens: 200,
    apiKey: process.env.OPENAI_API_KEY,
  });

  const response = await model.invoke([
    new SystemMessage(SYSTEM_PROMPT),
    new HumanMessage(prompt),
  ]);

  console.log(response)
  const raw = (response as any)?.content?.toString?.() ?? (response as any)?.text ?? JSON.stringify(response ?? "");
  const cleaned = cleanModelOutput(raw);
  const jsonStr = extractJson(cleaned);

  if (!jsonStr) {
    // modelo não retornou JSON — devolver null (podemos tentar um retry se quiser)
    return null;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    return null;
  }

  // Normalizar/validar campos recebidos do modelo
  let produto = parsed.produto ?? null;
  if (productoIsInvalid(produto)) produto = null;

  const validadeNorm = normalizeDate(parsed.validade ?? null);
  const diasAntes =
    parsed.diasAntes != null && !Number.isNaN(Number(parsed.diasAntes))
      ? Number(parsed.diasAntes)
      : null;

  // Se o modelo devolveu tudo nulo -> retornar null
  if (!produto && !validadeNorm && diasAntes == null) return null;

  return {
    produto,
    validade: validadeNorm,
    diasAntes,
  };
}

/* ===================== Util: validação simples de produto retornado pela IA ===================== */

function productoIsInvalid(name?: any): boolean {
  if (!name) return true;
  if (typeof name !== "string") return true;
  const s = name.trim();
  if (s.length < 2) return true;
  if (!/[aeiouáéíóúãõAEIOUÁÉÍÓÚÃÕ]/.test(s)) return true; // exige vogal
  if (/^\d+$/.test(s)) return true;
  return false;
}

/* ===================== Util: calcular data do lembrete ===================== */

export function calcularDataLembrete(validadeYmd: string | null, diasAntes: number | null): string | null {
  if (!validadeYmd) return null;
  const [y, m, d] = validadeYmd.split("-").map(Number);
  const validadeDate = new Date(y, m - 1, d);
  const deltaDays = diasAntes ?? 0;
  const lemb = new Date(validadeDate);
  lemb.setDate(lemb.getDate() - deltaDays);

  const now = nowInSaoPaulo();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (lemb < today) return null;
  return `${lemb.getFullYear()}-${pad(lemb.getMonth()+1)}-${pad(lemb.getDate())}`;
}
