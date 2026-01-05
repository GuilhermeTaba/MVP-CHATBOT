import sharp from "sharp";
import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";

/**
 * Recebe SOMENTE um Buffer de imagem
 * Envia direto para OpenAI (LangChain)
 * Retorna SOMENTE a validade (YYYY-MM-DD) ou null
 */
export async function getValidadeFromImageAI(
  imageBuffer: Buffer
): Promise<string | null> {
  // 1) reduzir imagem para gastar menos tokens visuais
  const optimized = await sharp(imageBuffer)
    .rotate()
    .resize({ width: 900, withoutEnlargement: true })
    .jpeg({ quality: 75 })
    .toBuffer();

  const dataUri = `data:image/jpeg;base64,${optimized.toString("base64")}`;

  // 2) modelo multimodal (baixo custo)
  const llm = new ChatOpenAI({
    modelName: "gpt-5-mini", // ou gpt-4o-mini
    maxTokens: 20,
    temperature: 0
  });

  // 3) prompt mínimo (economia máxima)
  const systemPrompt =
    'Extraia a data de validade da imagem. ' +
    'Responda SOMENTE com "YYYY-MM-DD" ou "null".';

  try {
    const res = await llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(`![imagem](${dataUri})`)
    ]);

    const output = String((res as any)?.content ?? "").trim();

    // aceita apenas data válida ou null
    if (output.toLowerCase() === "null") return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(output)) return output;

    return null;
  } catch (err) {
    console.error("[requestParsingBotFromImage] erro:", err);
    return null;
  }
}
