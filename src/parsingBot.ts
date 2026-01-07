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
  'Retorne SOMENTE JSON com as chaves: {"produto":string|null,"validade":"YYYY-MM-DD"|null,"diasAntes":number|null}.' +
  ' Use YYYY-MM-DD quando possível; ao inferir ano, escolha o próximo ano possível no timezone America/Sao_Paulo.' +
  ' Aceite datas em pt-BR (ex.: 25/01, 25/01/26, 25 de janeiro).' +
  ' Se não houver informação suficiente para um campo, retorne null.' +
  'Se for so um numero é diasAntes'+
  ' NÃO acrescente texto explicativo, comentários ou markdown — somente um objeto JSON.';

/* ===================== Helpers ===================== */

function nowInSaoPaulo(): Date {
  const s = new Date().toLocaleString("en-US", { timeZone: TIMEZONE });
  return new Date(s);
}
function pad(n: number) {
  return String(n).padStart(2, "0");
}

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
    const d = Number(m[1]),
      mon = Number(m[2]),
      y = Number(m[3]);
    if (isValidDateParts(y, mon, d)) return `${y}-${pad(mon)}-${pad(d)}`;
    return null;
  }

  // DD/MM/YY
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (m) {
    const d = Number(m[1]),
      mon = Number(m[2]),
      y = 2000 + Number(m[3]);
    if (isValidDateParts(y, mon, d)) return `${y}-${pad(mon)}-${pad(d)}`;
    return null;
  }

  // DD/MM (inferir ano)
  m = t.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) {
    const d = Number(m[1]),
      mon = Number(m[2]);
    return inferYearThenFormat(d, mon);
  }

  // formatos em pt-BR "25 de janeiro" ou "25 janeiro 2026"
  const months: { [k: string]: number } = {
    janeiro: 1, jan: 1, fevereiro: 2, fev: 2, marco: 3, março: 3, mar: 3,
    abril: 4, abr: 4, maio: 5, mai: 5, junho: 6, jun: 6, julho: 7, jul: 7,
    agosto: 8, ago: 8, setembro: 9, set: 9, outubro: 10, out: 10,
    novembro: 11, nov: 11, dezembro: 12, dez: 12
  };

  const mt = t.match(/^\s*(\d{1,2})(?:\s*de\s*|\s+)([^\d]+?)(?:\s+(\d{4}))?\s*$/i);
  if (mt) {
    const d = Number(mt[1]);
    let monthWord = (mt[2] || "").toLowerCase().trim();
    monthWord = monthWord.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    let mon = months[monthWord] ?? months[monthWord.slice(0, 3)];
    if (!mon) {
      mon = months[monthWord.split(/\s+/)[0]] ?? months[monthWord.slice(0, 3)];
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
  const mdays = [31, (isLeap(y) ? 29 : 28), 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
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

/**
 * Versão robusta da requestParsingBot:
 * - tenta extrair texto de várias formas que LangChain/OpenAI podem retornar
 * - faz retry quando `finish_reason === "length"`
 * - loga raw/cleaned/json para debug quando não encontra JSON
 */
export async function requestParsingBot(prompt: string): Promise<ParsedReminder | null> {
  if (!prompt || prompt.trim().length < 2) return null;

  // evitar respostas triviais de confirmação
  if (/^\s*(sim|s|ok|okay|yes|no|não|nao|cancelar)\s*$/i.test(prompt)) return null;

  // Helper: extrair string textual do objeto de resposta (cobre variantes LangChain/OpenAI)
  function getTextFromResponse(resp: any): string {
    if (!resp) return "";
    if (typeof resp === "string") return resp;

    // LangChain/AIMessage style
    if (typeof resp.content === "string" && resp.content.trim().length > 0) return resp.content;
    if (Array.isArray(resp.content) && resp.content.length > 0) {
      // pode ser [{ type: 'output_text', text: '...' }]
      const first = resp.content[0];
      if (typeof first === "string" && first.trim()) return first;
      if (first && typeof first.text === "string" && first.text.trim()) return first.text;
    }

    // older shape: resp.text
    if (typeof resp.text === "string" && resp.text.trim().length > 0) return resp.text;

    // OpenAI-like generations
    if (resp.generations && Array.isArray(resp.generations) && resp.generations.length > 0) {
      const g0 = resp.generations[0];
      if (typeof g0.text === "string" && g0.text.trim().length > 0) return g0.text;
      if (g0.message && typeof g0.message.content === "string" && g0.message.content.trim()) return g0.message.content;
    }

    // LangChain newer: resp.output
    if (resp.output) {
      if (typeof resp.output === "string" && resp.output.trim()) return resp.output;
      if (Array.isArray(resp.output) && resp.output.length > 0) {
        for (const o of resp.output) {
          if (typeof o === "string" && o.trim()) return o;
          if (o && typeof o.content === "string" && o.content.trim()) return o.content;
          if (o && Array.isArray(o.content) && o.content[0] && o.content[0].text) return o.content[0].text;
        }
      }
    }

    // fallback para debug: stringify
    try {
      return JSON.stringify(resp);
    } catch {
      return String(resp);
    }
  }

  // função que chama o modelo com determinado maxTokens
  async function callModel(maxTokens = 512) {
    const model = new ChatOpenAI({
      modelName: "gpt-5-mini",
      maxTokens,
      apiKey: process.env.OPENAI_API_KEY,
    });

    const resp = await model.invoke([
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(prompt),
    ]);

    return resp;
  }

  // primeira tentativa (mais tokens que antes para reduzir truncamentos)
  let response: any;
  try {
    response = await callModel(512);
  } catch (err) {
    console.error("Erro ao chamar modelo:", err);
    return null;
  }

  const raw = getTextFromResponse(response) ?? "";
  const cleaned = cleanModelOutput(raw);
  const jsonStr = extractJson(cleaned);

  const finishReason = (response?.response_metadata?.finish_reason) ?? (response?.finish_reason) ?? null;

  // retry se truncado (finish_reason === "length") ou se não encontrou JSON
  if ((!jsonStr || jsonStr === null) && finishReason === "length") {
    console.warn("Resposta truncada (finish_reason=length). Tentando retry com mais tokens...");
    try {
      response = await callModel(1024);
      const raw2 = getTextFromResponse(response) ?? "";
      const cleaned2 = cleanModelOutput(raw2);
      const jsonStr2 = extractJson(cleaned2);
      if (jsonStr2) return parseAndNormalizeJson(jsonStr2);
      // se retry também não tiver JSON, logamos para debug
      console.warn("Retry não retornou JSON. cleaned output (retry):", cleaned2);
      return null;
    } catch (err) {
      console.error("Erro no retry:", err);
      return null;
    }
  }

  if (!jsonStr) {
    // log detalhado para debugging local — útil durante ajuste do prompt
    console.warn("Modelo não retornou JSON detectável.");
    console.warn("raw:", raw);
    console.warn("cleaned:", cleaned);
    return null;
  }

  return parseAndNormalizeJson(jsonStr);

  /* ---------------- helper para parsear e normalizar (mesma lógica que você já tinha) ---------------- */
  function parseAndNormalizeJson(jsonText: string): ParsedReminder | null {
    let parsed: any;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      console.error("JSON.parse falhou em jsonStr:", jsonText, err);
      return null;
    }

    let produto = parsed.produto ?? null;
    if (productoIsInvalid(produto)) produto = null;

    const validadeNorm = normalizeDate(parsed.validade ?? null);
    const diasAntes =
      parsed.diasAntes != null && !Number.isNaN(Number(parsed.diasAntes))
        ? Number(parsed.diasAntes)
        : null;

    // Se tudo for nulo -> retornar null (mantém comportamento anterior)
    if (!produto && !validadeNorm && diasAntes == null) return null;

    return {
      produto,
      validade: validadeNorm,
      diasAntes,
    };
  }
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
  return `${lemb.getFullYear()}-${pad(lemb.getMonth() + 1)}-${pad(lemb.getDate())}`;
}
