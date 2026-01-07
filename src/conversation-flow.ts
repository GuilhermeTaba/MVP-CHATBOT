// conversation-flow.ts
import { Client, Message } from "whatsapp-web.js";
import { requestParsingBot } from "./parsingBot";
import { saveReminder, scheduleReminder } from "./reminders";
import { getValidadeFromImageAI } from "./processImageWithAi";

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
let clientRef: Client | null = null;

/** Idempotência: garante que attachConversationFlow só registre handlers uma vez */
let _conversationAttached = false;

/** dedupe de envios: previne mensagens idênticas para o mesmo chat em curto prazo */
const recentSends = new Map<string, { text: string; ts: number }>();
const DEDUPE_WINDOW_MS = 8000;

function isDuplicateSend(chatId: string, text: string): boolean {
  const key = String(chatId);
  const now = Date.now();
  const rec = recentSends.get(key);
  if (!rec) {
    recentSends.set(key, { text, ts: now });
    setTimeout(() => {
      const cur = recentSends.get(key);
      if (cur && cur.ts === now) recentSends.delete(key);
    }, DEDUPE_WINDOW_MS + 100);
    return false;
  }
  if (rec.text === text && now - rec.ts < DEDUPE_WINDOW_MS) {
    return true;
  }
  recentSends.set(key, { text, ts: now });
  setTimeout(() => {
    const cur = recentSends.get(key);
    if (cur && cur.ts === now) recentSends.delete(key);
  }, DEDUPE_WINDOW_MS + 100);
  return false;
}

function formatDateBR(dateISO: string | null | undefined): string | null {
  if (!dateISO) return null;
  const match = dateISO.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  return `${day}/${month}/${year}`;
}

/** --- Funções seguras que previnem throws vindos do puppeteer / client internals --- */

async function safeGetChatById(id: string, attempts = 1): Promise<any | null> {
  if (!clientRef) return null;
  try {
    return await clientRef.getChatById(id);
  } catch (err: any) {
    console.warn("[conversation-flow] safeGetChatById erro", { id, err: err?.message ?? err });
    if (attempts > 0) {
      await new Promise((r) => setTimeout(r, 200));
      return safeGetChatById(id, attempts - 1);
    }
    return null;
  }
}

async function safeSendMessage(chatId: string, text: string): Promise<boolean> {
  if (!clientRef) return false;
  try {
    await clientRef.sendMessage(chatId, text);
    return true;
  } catch (err: any) {
    console.error("[conversation-flow] safeSendMessage erro", { chatId, err: err?.message ?? err });
    return false;
  }
}

async function safeSendWithDedupe(chatId: string, text: string): Promise<boolean> {
  try {
    if (isDuplicateSend(chatId, text)) {
      console.log('[conversation-flow] duplicado detectado — ignorando envio', { chatId, snippet: text.slice(0, 80) });
      return false;
    }
    return await safeSendMessage(chatId, text);
  } catch (err) {
    console.error('[conversation-flow] safeSendWithDedupe erro', err);
    return false;
  }
}

async function safeSendStateTyping(chat: any): Promise<void> {
  if (!chat || typeof chat.sendStateTyping !== "function") return;
  try {
    await chat.sendStateTyping();
  } catch (err: any) {
    console.warn("[conversation-flow] safeSendStateTyping erro", { err: err?.message ?? err });
  }
}

async function safeClearState(chat: any): Promise<void> {
  if (!chat || typeof chat.clearState !== "function") return;
  try {
    await chat.clearState();
  } catch (err: any) {
    console.warn("[conversation-flow] safeClearState erro", { err: err?.message ?? err });
  }
}

/** substitui o antigo log(...) — não lança e usa dedupe */
async function safeLog(chatId: string, text: string) {
  try {
    const chat = await safeGetChatById(chatId);
    if (chat) {
      await safeSendStateTyping(chat);
      await new Promise((r) => setTimeout(r, 800));
      await safeSendWithDedupe(chatId, text);
      await safeClearState(chat);
    } else {
      await safeSendWithDedupe(chatId, text);
    }
  } catch (err: any) {
    console.error("[conversation-flow] safeLog erro inesperado", { chatId, err: err?.message ?? err });
  }
}

/** Mescla o resultado do parser no draft, sem sobrescrever campos já preenchidos */
function mergeParsedIntoDraft(session: Session, parsed: ParsedReminder | null): string[] {
  if (!parsed) return [];
  const filled: string[] = [];

  if (parsed.produto != null) {
    const p = parsed.produto.trim();
    if (p.length > 0) {
      session.draft.produto = p.charAt(0).toUpperCase() + p.slice(1);
      filled.push("produto");
    }
  }

  if (parsed.validade != null) {
    session.draft.validade = parsed.validade;
    filled.push("validade");
  }

  if (parsed.diasAntes != null) {
    session.draft.diasAntes = parsed.diasAntes;
    filled.push("diasAntes");
  }

  return filled;
}

function getNextPrompt(session: Session): { state: State; message: string } {
  const { produto, validade, diasAntes } = session.draft;
  const validadeFormatada = formatDateBR(session.draft.validade);

  if (!validade) {
    return {
      state: "WAIT_IMAGE",
      message:
        "Olá! 👋 Eu sou o *Lembre Aí* 🕒📦\n\n" +
        "Minha tarefa é te ajudar a lembrar da *validade dos seus produtos* para evitar desperdícios.\n\n" +
        "👉 Por favor, envie a *foto do rótulo com a data de validade* para que eu possa criar um lembrete para você.",
    };
  }

  if (diasAntes == null) {
    return {
      state: "WAIT_DAYS",
      message:
        "Perfeito! ⏰✨\n\n" +
        "Agora me conta: *com quantos dias de antecedência* você gostaria de receber o lembrete antes da validade?",
    };
  }

  if (!produto) {
    return {
      state: "WAIT_PRODUCT",
      message:
        "Ótimo! 😊\n\n" +
        "Agora me diga: *qual é o nome do produto*?\n\n" +
        "👉 Exemplo: Leite Integral, Iogurte Natural, Molho de Tomate",
    };
  }

  return {
    state: "CONFIRM",
    message:
      `Tudo certo por aqui! ✅\n\n` +
      `📦 *Produto:* ${produto}\n` +
      `📅 *Validade:* ${validadeFormatada}\n` +
      `⏰ *Aviso:* ${diasAntes} dias antes\n\n` +
      `👉 Responda *sim* para confirmar ou *cancelar* para abortar.`,
  };
}

/** Attach conversation flow de forma idempotente e segura */
export function attachConversationFlow(client: Client) {
  if (_conversationAttached) {
    console.log('[conversation-flow] já anexado — ignorando nova chamada.');
    return;
  }
  _conversationAttached = true;

  clientRef = client;

  client.on("message", async (message: Message) => {
    try {
      // log curto para depurar duplicatas (mesma message.id aparece duas vezes se duplicado)
      console.log('[conversation-flow] handler message firing', { pid: process.pid, from: message.from, id: message.id?.id ?? message.id });

      const chatId = message.from;
      const text = (message.body || "").trim();

      // Garantir que a sessão exista (cria se necessário)
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
        await safeLog(chatId, "Operação cancelada ✅");
        return;
      }

      if (session.state === "CONFIRM") {
        if (/^(não|nao|cancel(ar)?)$/i.test(text)) {
          await safeLog(chatId, "Cancelado ❌\n\nTudo bem! Se precisar, é só me chamar 😊");
          sessions.delete(chatId);
          return;
        }

        if (/^sim$/i.test(text)) {
          if (!session.draft.produto || !session.draft.validade || session.draft.diasAntes == null) {
            const next = getNextPrompt(session);
            session.state = next.state;
            await safeLog(chatId, `Quase lá! 😄 Parece que ainda falta alguma informação.\n\n${next.message}`);
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
            await safeLog(chatId, "✅ Lembrete salvo com sucesso!\n\nPode ficar tranquilo(a), eu te aviso na hora certa 🕒📦");
          } catch (err) {
            console.error("Erro ao salvar/agendar lembrete:", err);
            await safeLog(chatId, "Opa 😕 ocorreu um erro ao salvar o lembrete.\n\nPor favor, tente novamente mais tarde.");
          } finally {
            sessions.delete(chatId);
          }
          return;
        }
      }

      // WAIT_DAYS: aceitar número direto
      if (text && session.state === "WAIT_DAYS") {
        const numMatch = text.match(/^\s*"?(-?\d+)"?\s*$/);
        if (numMatch) {
          const n = Number(numMatch[1]);
          if (!Number.isNaN(n) && n >= 0 && n <= 3650) {
            session.draft.diasAntes = n;
            const next = getNextPrompt(session);
            session.state = next.state;
            await safeLog(chatId, `Perfeito — vou te avisar ${n} dias antes. ✅\n\n${next.message}`);
            return;
          } else {
            await safeLog(chatId, "Hmm — esse número parece inválido. Por favor envie um número inteiro de dias (ex.: 3).");
            return;
          }
        }
      }

      // texto: tentar parsing e mesclar
      if (text) {
        try {
          const parsed = (await requestParsingBot(text)) as ParsedReminder | null;
          mergeParsedIntoDraft(session, parsed);
          const next = getNextPrompt(session);
          session.state = next.state;
          await safeLog(chatId, next.message);
          return;
        } catch (err) {
          console.error("Erro ao chamar requestParsingBot:", err);
          // segue adiante sem quebrar
        }
      }

      // se sessão recém-criada, enviar prompt inicial
      if (createdNewSession) {
        const next = getNextPrompt(session);
        session.state = next.state;
        await safeLog(chatId, next.message);
        return;
      }

      // processar mídia (imagem)
      if (message.hasMedia) {
        if (!session.draft.validade) {
          await safeLog(chatId, "Processando a imagem... ⏳📸");
          try {
            const media = await message.downloadMedia();
            if (!media?.data) {
              await safeLog(chatId, "Ops! 😕 Não consegui ler a imagem.\n\nPode tentar enviar outra foto, de preferência com a *data de validade bem visível*?");
              return;
            }

            const buffer = Buffer.from(media.data, "base64");
            let validade: string | null = null;
            try {
              validade = await getValidadeFromImageAI(buffer);
            } catch (err) {
              console.error("Erro ao chamar getValidadeFromImageAI:", err);
              validade = null;
            }

            if (!validade) {
              await safeLog(chatId, "Não consegui identificar a data de validade nessa imagem 😕\n\nPode enviar outra foto mais nítida ou com a *data bem visível*, por favor?");
              const next = getNextPrompt(session);
              session.state = next.state;
              return;
            }

            session.draft.validade = validade;
            const next = getNextPrompt(session);
            session.state = next.state;
            await safeLog(chatId, next.message);
            return;
          } catch (err) {
            console.error("Erro ao processar imagem:", err);
            await safeLog(chatId, "Ocorreu um erro ao processar a imagem 😕\n\nPode tentar enviar outra foto, por favor?");
            return;
          }
        } else {
          const next = getNextPrompt(session);
          session.state = next.state;
          await safeLog(chatId, `Perfeito! ✅ Já encontrei a data de validade.\n\n${next.message}`);
          return;
        }
      }

      // fallback: reenviar prompt apropriado
      const next = getNextPrompt(session);
      session.state = next.state;
      await safeLog(chatId, next.message);
    } catch (err) {
      // captura tudo no handler pra evitar unhandledRejection
      console.error("[conversation-flow] erro inesperado no handler de message:", err);
      // não relançar — mantemos o processo vivo
    }
  });
}
