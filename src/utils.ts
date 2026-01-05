/**
 * Decide qual o próximo estado e a mensagem a ser enviada com base no que falta no draft.
 */
function getNextPrompt(session: Session): { state: State; message: string } {
  const { produto, validade, daysBefore } = session.draft;

  if (!validade) {
    return {
      state: "WAIT_IMAGE",
      message:
        "Olá! 👋 Eu sou o *Lembre Aí* 🕒📦\n\n" +
        "Minha tarefa é te ajudar a lembrar da *validade dos seus produtos* para evitar desperdícios.\n\n" +
        "👉 Por favor, envie a *foto do produto ou do rótulo com a data de validade* para que eu possa criar um lembrete para você.",
    };
  }

  if (daysBefore == null) {
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
      `Avisar: ${daysBefore} dias antes\n\n` +
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
    parsed.daysBefore != null &&
    !Number.isNaN(parsed.daysBefore) &&
    session.draft.daysBefore == null
  ) {
    session.draft.daysBefore = parsed.daysBefore;
    filled.push("daysBefore");
  }

  return filled;
}
