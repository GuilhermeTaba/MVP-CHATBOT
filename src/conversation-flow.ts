// conversation-flow.ts
import { Client, Message } from "whatsapp-web.js";
import { requestParsingBotFromImage } from "./processImage";
import { requestParsingBot } from "./parsingBot";
import { saveReminder, scheduleReminder } from "./reminders";
import { getValidadeFromImageAI } from "./processImageWithAi";
import { parse } from "node:path";

type State = "WAIT_IMAGE" | "WAIT_DAYS" | "WAIT_PRODUCT" | "CONFIRM";

type Session = {
  state: State;
  draft: {
    produto?: string | null;
    validade?: string | null;
    diasAntes?: number | null;
  };
};

type ParsedReminder = {
  produto?: string | null;
  validade?: string | null;
  diasAntes?: number | null;
};

const sessions = new Map<string, Session>();
let clientRef: Client;

async function log(chatId: string, text: string) {
  const chat = await clientRef.getChatById(chatId);

  // mostra "digitando..."
  await chat.sendStateTyping();

  await new Promise(r => setTimeout(r, 800));

  await clientRef.sendMessage(chatId, text);

  // remove estado de digitação
  await chat.clearState();
}

/**
 * Decide qual o próximo estado e a mensagem a ser enviada com base no que falta no draft.
 */
function getNextPrompt(session: Session): { state: State; message: string } {
  const { produto, validade, diasAntes } = session.draft;

  if (!validade) {
    return {
      state: "WAIT_IMAGE",
      message:
        "Olá! 👋 Eu sou o *Lembre Aí* 🕒📦\n\n" +
        "Minha tarefa é te ajudar a lembrar da *validade dos seus produtos* para evitar desperdícios.\n\n" +
        "👉 Por favor, envie a *foto do produto ou do rótulo com a data de validade* para que eu possa criar um lembrete para você.",
    };
  }

  if (diasAntes == null) {
    return {
      state: "WAIT_DAYS",
      message: "Quantos dias antes da validade você quer ser avisado? (Ex: 7)",
    };
  }

  if (!produto) {
    return {
      state: "WAIT_PRODUCT",
      message: "Qual é o nome do produto?",
    };
  }

  return {
    state: "CONFIRM",
    message:
      `Confirma?\n` +
      `Produto: ${produto}\n` +
      `Validade: ${validade}\n` +
      `Avisar: ${diasAntes} dias antes\n\n` +
      `Responda *sim* para confirmar ou *cancelar* para abortar.`,
  };
}

/**
 * Mescla o resultado do parser no draft, sem sobrescrever campos já preenchidos e sem aceitar null/undefined.
 * Retorna a lista de campos que foram preenchidos agora (para feedback).
 */
function mergeParsedIntoDraft(session: Session, parsed: ParsedReminder | null): string[] {
  if (!parsed) return [];

  const filled: string[] = [];

  if (parsed.produto != null && session.draft.produto == null) {
    session.draft.produto = parsed.produto;
    filled.push("produto");
  }

  if (parsed.validade != null && session.draft.validade == null) {
    session.draft.validade = parsed.validade;
    filled.push("validade");
  }

  if (
    parsed.diasAntes != null &&
    !Number.isNaN(parsed.diasAntes) &&
    session.draft.diasAntes == null
  ) {
    session.draft.diasAntes = parsed.diasAntes;
    filled.push("diasAntes");
  }

  return filled;
}

export function attachConversationFlow(client: Client) {
  clientRef = client;

  client.on("message", async (message: Message) => {
    const chatId = message.from;
    const text = (message.body || "").trim();

    // Garantir que a sessão exista (cria se necessário) — evita "possibly undefined".
    let session = sessions.get(chatId);
    let createdNewSession = false;
    if (!session) {
      session = { state: "WAIT_IMAGE", draft: {} };
      sessions.set(chatId, session);
      createdNewSession = true;
    }

    // comando global "cancelar"
    if (/^cancelar$/i.test(text)) {
      sessions.delete(chatId);
      log(chatId, "Operação cancelada ✅");
      return;
    }

    // 1) Se veio texto, tente extrair info com o parsing bot e mesclar no draft
    if (text) {
      try {
        const parsed = await requestParsingBot(text) as ParsedReminder | null;
        console.log(parsed)
        const filled = mergeParsedIntoDraft(session, parsed);
        console.log("CHAMOU PARSING BOT")
      } catch (err) {
        console.error("Erro ao chamar requestParsingBot:", err);
        // se o parser falhar, não interrompemos o fluxo — apenas seguimos abaixo
      }
    }

    // Se acabamos de criar a sessão e não houve preenchimento por texto/mídia, envie o prompt inicial
    // (isso garante que o usuário veja a orientação ao iniciar)
    if (createdNewSession) {
      const next = getNextPrompt(session);
      session.state = next.state;

      console.log(text)
      log(chatId, next.message);
      return;
    }

    // 2) Processar mídia (imagem) para extrair validade — só se não tivermos validade ainda
    if (message.hasMedia) {
      if (!session.draft.validade) {
        log(chatId, "Processando imagem...");
        try {
          const media = await message.downloadMedia();
          if (!media?.data) {
            log(chatId, "Não consegui ler a imagem, tente novamente.");
            return;
          }

          const buffer = Buffer.from(media.data, "base64");
          const ImgScanned = await requestParsingBotFromImage(buffer, "por+eng");
          
          if (!ImgScanned) {
            log(chatId, "Não consegui extrair texto da imagem. Pode enviar uma foto mais nítida ou com a data mais visível?");
            // opcional: reenviar o prompt atual para orientar o usuário
            const next = getNextPrompt(session);
            session.state = next.state;
            return;
          }
          console.log(ImgScanned.validade)
          // Agora temos certeza de que textScanned é string — seguro passar para o parser

          session.draft.validade = ImgScanned.validade

          const next = getNextPrompt(session);
          session.state = next.state;
          log(chatId, next.message);
          return;
        } catch (err) {
          console.error("Erro ao processar imagem:", err);
          log(chatId, "Ocorreu um erro processando a imagem. Tente novamente.");
          return;
        }
      } else {
        // já temos validade; avisar o que falta
        const next = getNextPrompt(session);
        session.state = next.state;
        log(chatId, `Já encontrei uma validade.\n\n${next.message}`);
        return;
      }
    }

    // 5) Confirmação final
    if (session.state === "CONFIRM") {
      if (!/^sim$/i.test(text)) {
        log(chatId, "Cancelado ❌");
        sessions.delete(chatId);
        return;
      }

      // validação final: garantir que não estão undefined
      if (
        !session.draft.produto ||
        !session.draft.validade ||
        session.draft.diasAntes == null
      ) {
        // algo faltando — recalcular próximo prompt
        const next = getNextPrompt(session);
        session.state = next.state;
        log(chatId, `Alguma informação está faltando. ${next.message}`);
        return;
      }

      const reminder = {
        id: `rem-${Date.now()}`,
        chatId,
        produto: session.draft.produto!,
        validade: session.draft.validade!,
        diasAntes: session.draft.diasAntes!,
        createdAt: new Date().toISOString(),
      };

      try {
        await saveReminder(reminder);
        await scheduleReminder(reminder);

        log(chatId, "✅ Lembrete salvo com sucesso!");
      } catch (err) {
        console.error("Erro ao salvar/agendar lembrete:", err);
        log(chatId, "Ocorreu um erro ao salvar o lembrete. Tente novamente mais tarde.");
      } finally {
        sessions.delete(chatId);
      }
      return;
    }

    // 6) Caso texto não tenha sido útil e estado não capturou a ação, reenviar prompt apropriado
    const next = getNextPrompt(session);
    session.state = next.state;
 
    log(chatId, next.message);
  });
}
