import fs from "fs";
import sharp from "sharp";
import { createWorker, PSM } from "tesseract.js";

/**
 * Resultado público: apenas validade (YYYY-MM-DD) e confiança (0-100)
 */
export type ParsedImageValidity = {
  validade: string | null;
  confianca: number | null;
};

/* -------------------------
   Config / utilitários
   ------------------------- */
const MONTHS_PT: Record<string, string> = {
  janeiro: "01", jan: "01",
  fevereiro: "02", fev: "02",
  março: "03", mar: "03", marco: "03",
  abril: "04", abr: "04",
  maio: "05",
  junho: "06", jun: "06",
  julho: "07", jul: "07",
  agosto: "08", ago: "08",
  setembro: "09", set: "09",
  outubro: "10", out: "10",
  novembro: "11", nov: "11",
  dezembro: "12", dez: "12"
};

function isValidDate(y: number, m: number, d: number): boolean {
  if (y < 2000 || y > 2100) return false; // regra de negócio, ajuste se quiser
  if (m < 1 || m > 12) return false;
  const max = new Date(y, m, 0).getDate();
  return d >= 1 && d <= max;
}

function normalizeDate(input?: string | null): string | null {
  if (!input) return null;
  const s = String(input).toLowerCase().replace(/\s+/g, " ").trim();

  // YYYY-MM-DD or YYYY/MM/DD or YYYY.MM.DD
  let m = s.match(/(20\d{2})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (isValidDate(y, mo, d)) return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
  m = s.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](20\d{2})/);
  if (m) {
    const d = +m[1], mo = +m[2], y = +m[3];
    if (isValidDate(y, mo, d)) return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  // "10 de janeiro de 2026" (aceita variações)
  m = s.match(/(\d{1,2})\s*de\s*([a-zçãéíóú]+)\s*(?:de\s*)?(20\d{2})/i);
  if (m) {
    const d = +m[1];
    const monthName = m[2].toLowerCase();
    const month = MONTHS_PT[monthName] ?? MONTHS_PT[monthName.slice(0, 3)];
    const y = +m[3];
    if (month && isValidDate(y, +month, d)) return `${y}-${month}-${String(d).padStart(2, "0")}`;
  }

  // MM/YY -> assume 20YY, day = 01 (apenas quando outro formato não batizou)
  m = s.match(/\b(0?[1-9]|1[0-2])[\/\-](\d{2})\b/);
  if (m) {
    const mm = +m[1];
    const yy = +m[2];
    const yyyy = yy >= 70 ? 1900 + yy : 2000 + yy;
    if (isValidDate(yyyy, mm, 1)) return `${yyyy}-${String(mm).padStart(2, "0")}-01`;
  }

  return null;
}

function extractDateCandidate(text: string): string | null {
  if (!text) return null;
  // busca padrões comuns e retorna o primeiro candidato bruto
  const patterns = [
    /\b\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4}\b/,     // DD/MM/YYYY
    /\b\d{4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2}\b/,     // YYYY-MM-DD
    /\b\d{1,2}\s*de\s*[a-zçãéíóú]+\s*de\s*\d{4}\b/i, // "10 de janeiro de 2026"
    /\b(0?[1-9]|1[0-2])[\/\-]\d{2}\b/               // MM/YY
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[0];
  }
  return null;
}

/* -------------------------
   Função principal
   ------------------------- */

/**
 * Processa imagem (caminho ou Buffer), roda tesseract.js e retorna { validade, confianca }.
 * - lang: 'por' ou 'por+eng' etc (depende do traineddata instalado)
 */
export async function requestParsingBotFromImage(
  image: string | Buffer,
  lang: string = "por"
): Promise<ParsedImageValidity> {
  // 1) ler buffer
  const buffer = typeof image === "string" ? fs.readFileSync(image) : image;

  // 2) pré-processamento leve com sharp (melhora OCR)
  const processed = await sharp(buffer)
    .rotate()
    .resize({ width: 1400, withoutEnlargement: true })
    .grayscale()
    .sharpen()
    .toBuffer();

  // 3) criar worker — cast para any para evitar problemas de tipagem dependendo da versão
  const workerRaw = await Promise.resolve(createWorker());
  const worker: any = workerRaw;

  try {
    // NOTE: call to worker.load() was removed (depreciated). Keep guards for compatibility.
    // carrega linguagem (se disponível)
    if (typeof worker.loadLanguage === "function") await worker.loadLanguage(lang);
    if (typeof worker.initialize === "function") await worker.initialize(lang);

    // set parameters se disponível (usa PSM constante)
    if (typeof worker.setParameters === "function") {
      try {
        await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO } as any);
      } catch {
        // algumas versões aceitam setParameters com chaves diferentes; silenciar falha aqui
      }
    }

    // reconhecimento (OCR)
    const result = await worker.recognize(processed);

    // calcular confiança de forma robusta:
    // - se houver array `words`, calcular média das confidences (mais confiável)
    // - fallback para result.data.confidence se disponível
    let rawConfidence: number | null = null;
    if (result?.data?.words && Array.isArray(result.data.words) && result.data.words.length > 0) {
      const sum = result.data.words.reduce((acc: number, w: any) => {
        const c = typeof w.confidence === "number" ? w.confidence : (typeof w.confidence === "string" ? parseFloat(w.confidence) || 0 : 0);
        return acc + c;
      }, 0);
      rawConfidence = Math.round(sum / result.data.words.length);
    } else if (typeof result?.data?.confidence === "number") {
      rawConfidence = Math.round(result.data.confidence);
    } else if (typeof result?.data?.confidence === "string") {
      const parsed = parseFloat(result.data.confidence);
      rawConfidence = Number.isFinite(parsed) ? Math.round(parsed) : null;
    }

    const rawText: string = result?.data?.text ?? "";
    const candidate = extractDateCandidate(rawText);
    const validade = normalizeDate(candidate);

    // terminar worker (libera recursos) — só se função existir
    if (typeof worker.terminate === "function") await worker.terminate();

    return { validade, confianca: rawConfidence };
  } catch (err) {
    // tenta terminar worker em caso de erro
    try { if (typeof worker.terminate === "function") await worker.terminate(); } catch (_) {}
    console.error("[ParsingBotTesseract] erro:", err);
    return { validade: null, confianca: null };
  }
}

/* -------------------------
   Exemplo de uso (main)
   ------------------------- */
/*
  Para testar, execute com ts-node:
  npx ts-node parsingBotTesseract.ts

  (Descomente o bloco abaixo se quiser rodar como script)
*/

// (async () => {
//   const caminho = "rotulo.jpg"; // ajuste para sua imagem
//   const res = await requestParsingBotFromImage(caminho, "por");
//   console.log("Resultado:", res); // { validade: "2026-01-10", confianca: 87 }
//
//   function salvarValidadeNoDB(val: string | null) {
//     console.log("salvando no DB:", val);
//   }
//
//   salvarValidadeNoDB(res.validade ?? null);
// })();
