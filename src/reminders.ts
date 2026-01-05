// reminders.ts
import fs from "fs-extra";
import schedule from "node-schedule";

const FILE_PATH = "./reminders.json";

export type Reminder = {
  id: string;
  chatId: string;
  produto: string;
  validade: string;   // YYYY-MM-DD (vindo da sua IA)
  diasAntes: number;
  createdAt: string;
};

/* =========================
   Persistência simples
========================= */

async function loadAll(): Promise<Reminder[]> {
  try {
    return await fs.readJSON(FILE_PATH);
  } catch {
    return [];
  }
}

export async function saveReminder(reminder: Reminder) {
  const all = await loadAll();
  all.push(reminder);
  await fs.writeJSON(FILE_PATH, all, { spaces: 2 });
}

/* =========================
   Agendamento
========================= */

export async function scheduleReminder(reminder: Reminder) {
  const validadeDate = new Date(`${reminder.validade}T09:00:00`);
  const notifyDate = new Date(validadeDate);
  notifyDate.setDate(validadeDate.getDate() - reminder.diasAntes);

  // se a data já passou, não agenda
  if (notifyDate <= new Date()) {
    console.warn(
      `[REMINDER] Data já passou para ${reminder.produto} (${reminder.validade})`
    );
    return;
  }

  schedule.scheduleJob(reminder.id, notifyDate, async () => {
    // IMPORTANTE:
    // não envie mensagem aqui diretamente se quiser manter separação.
    // o ideal é importar um sender (ex: sendWhatsAppMessage)

    console.log(
      `[REMINDER] Avisar ${reminder.chatId}: ${reminder.produto} vence em ${reminder.validade}`
    );

    /*
      Exemplo se quiser enviar:
      await sendWhatsAppMessage(
        reminder.chatId,
        `⏰ Lembrete: *${reminder.produto}* vence em ${reminder.validade}`
      );
    */
  });
}
