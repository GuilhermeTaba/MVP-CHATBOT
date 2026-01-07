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
let clientRef: Client;



function formatDateBR(dateISO: string | null | undefined): string | null {
  if (!dateISO) return null;

  // aceita exatamente YYYY-MM-DD
  const match = dateISO.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const [, year, month, day] = match;

  // validação simples de data real
  const date = new Date(`${year}-${month}-${day}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;

  return `${day}/${month}/${year}`;}

async function log(chatId: string, text: string) {
  const chat = await clientRef.getChatById(chatId);

  // mostra "digitando..."
  await chat.sendStateTyping();

  await new Promise((r) => setTimeout(r, 800));

  await clientRef.sendMessage(chatId, text);

  // remove estado de digitação
  await chat.clearState();
}

/**
 * Decide qual o próximo estado e a mensagem a ser enviada com base no que falta no draft.
 */
function getNextPrompt(session: Session): { state: State; message: string } {
  const { produto, validade, diasAntes } = session.draft;
  const validadeFormatada = formatDateBR(session.draft.validade) 

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

/**
 * Mescla o resultado do parser no draft, sem sobrescrever campos já preenchidos e sem aceitar null/undefined.
 * Retorna a lista de campos que foram preenchidos agora (para feedback).
 */
function mergeParsedIntoDraft(
  session: Session,
  parsed: ParsedReminder | null
): string[] {
  if (!parsed) return [];

  const filled: string[] = [];

  if (parsed.produto != null) {
    const p = parsed.produto.trim();
    if (p.length > 0) {
      session.draft.produto =
        p.charAt(0).toUpperCase() + p.slice(1);
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
      await log(chatId, "Operação cancelada ✅");
      return;
    }

       if (session.state === "CONFIRM") {

      // ❌ se for NÃO ou CANCELAR → cancela
      if (/^(não|nao|cancel(ar)?)$/i.test(text)) {
        await log(
          chatId,
          "Cancelado ❌\n\nTudo bem! Se precisar, é só me chamar 😊"
        );
        sessions.delete(chatId);
        return;
      }

      // ✅ se for SIM → continua normalmente
      if (/^sim$/i.test(text)) {

        // validação final: garantir que não estão undefined
        if (
          !session.draft.produto ||
          !session.draft.validade ||
          session.draft.diasAntes == null
        ) {
          const next = getNextPrompt(session);
          session.state = next.state;
          await log(
            chatId,
            `Quase lá! 😄 Parece que ainda falta alguma informação.\n\n${next.message}`
          );
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

          await log(
            chatId,
            "✅ Lembrete salvo com sucesso!\n\nPode ficar tranquilo(a), eu te aviso na hora certa 🕒📦"
          );
        } catch (err) {
          console.error("Erro ao salvar/agendar lembrete:", err);
          await log(
            chatId,
            "Opa 😕 ocorreu um erro ao salvar o lembrete.\n\nPor favor, tente novamente mais tarde."
          );
        } finally {
          sessions.delete(chatId);
        }

    
        return;
      }
    }


    // 1) Se veio texto, trate caso especial: se estamos em WAIT_DAYS e o usuário só mandou um número,
    //    aceitar diretamente como diasAntes (evita roundtrips e depende menos do parser).
    if (text && session.state === "WAIT_DAYS") {
      // aceita "3", '"3"', com espaços; somente inteiros (sem decimais)
      const numMatch = text.match(/^\s*"?(-?\d+)"?\s*$/);
      if (numMatch) {
        const n = Number(numMatch[1]);
        // validação simples: não aceitar negativos nem números absurdos
        if (!Number.isNaN(n) && n >= 0 && n <= 3650) {
          session.draft.diasAntes = n;
          // avançar para próximo prompt (produto ou confirmação)
          const next = getNextPrompt(session);
          session.state = next.state;

          // enviar resposta confirmando e já o próximo prompt (uma única mensagem)
          await log(
            chatId,
            `Perfeito — vou te avisar ${n} dias antes. ✅\n\n${next.message}`
          );
          return;
        } else {
          // número fora do intervalo esperado
          await log(
            chatId,
            "Hmm — esse número parece inválido. Por favor envie um número inteiro de dias (ex.: 3)."
          );
          return;
        }
      }
    }

    // 2) Se veio texto, tente extrair info com o parsing bot e mesclar no draft
    if (text) {
      try {
        const parsed = (await requestParsingBot(text)) as ParsedReminder | null;
    
        const filled = mergeParsedIntoDraft(session, parsed);

        const next = getNextPrompt(session);
        session.state = next.state;
        await log(chatId, next.message);
        return;
        
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

      await log(chatId, next.message);
      return;
    }

    // 3) Processar mídia (imagem) para extrair validade — só se não tivermos validade ainda
    if (message.hasMedia) {
      if (!session.draft.validade) {
        await log(chatId, "Processando a imagem... ⏳📸");

        try {
          const media = await message.downloadMedia();
          if (!media?.data) {
            await log(chatId, "Ops! 😕 Não consegui ler a imagem.\n\nPode tentar enviar outra foto, de preferência com a *data de validade bem visível*?");
            return;
          }

          const buffer = Buffer.from(media.data, "base64");

          // --- NOVO: usa a função que chama o LLM multimodal e retorna YYYY-MM-DD | null
          let validade: string | null = null;
          try {
            validade = await getValidadeFromImageAI(buffer);
            
          } catch (err) {
            console.error("Erro ao chamar getValidadeFromImageAI:", err);
            validade = null;
          }

          if (!validade) {
            await log(
              chatId,
              "Não consegui identificar a data de validade nessa imagem 😕\n\nPode enviar outra foto mais nítida ou com a *data bem visível*, por favor?"
            );
            // reenviar prompt atual
            const next = getNextPrompt(session);
            session.state = next.state;
            return;
          }

          // preenche o draft com a validade encontrada
          session.draft.validade = validade;

          const next = getNextPrompt(session);
          session.state = next.state;
          await log(chatId, next.message);
          return;
        } catch (err) {
          console.error("Erro ao processar imagem:", err);
          await log(
            chatId,
            "Ocorreu um erro ao processar a imagem 😕\n\nPode tentar enviar outra foto, por favor?"
          );
          return;
        }
      } else {
        // já temos validade; avisar o que falta
        const next = getNextPrompt(session);
        session.state = next.state;
        await log(chatId, `Perfeito! ✅ Já encontrei a data de validade.\n\n${next.message}`);
        return;
      }
        }

 
    // 5) Caso texto não tenha sido útil e estado não capturou a ação, reenviar prompt apropriado
    const next = getNextPrompt(session);
    session.state = next.state;

    await log(chatId, next.message);
  });
}
