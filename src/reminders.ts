// reminders.ts
import { MongoClient, Db, Collection } from "mongodb";
import schedule from "node-schedule";
import type { Client as WhatsAppClient } from "whatsapp-web.js";

const MONGO_KEY = process.env.MONGO_KEY 
// defaults (evita o erro 'string | undefined')
const DB_NAME = process.env.DB_NAME ?? "mvp-chatbot";
const COLLECTION_NAME = process.env.COLLECTION_NAME ?? "lembretes";

export type Reminder = {
  id: string;
  chatId: string;
  produto: string;
  validade: string; // YYYY-MM-DD
  diasAntes: number;
  createdAt: string;
  // opcionalmente: sentAt?: string; errorCount?: number;
};

let client: MongoClient | null = null;
let db: Db | null = null;
let collection: Collection<Reminder> | null = null;
let isConnectedFlag = false;

let whatsappClient: WhatsAppClient | null = null;
export function attachWhatsAppClient(c: WhatsAppClient) {
  whatsappClient = c;
}

/* =========================
   Conexão com Mongo
========================= */

export async function connectMongo(): Promise<void> {
  if (!MONGO_KEY) {
    throw new Error("MONGO_KEY não definido. Defina process.env.MONGO_KEY");
  }

  if (isConnectedFlag && client) return;

  client = new MongoClient(MONGO_KEY, {});
  await client.connect();

  db = client.db(DB_NAME); // agora DB_NAME sempre string (tem default)
  collection = db.collection<Reminder>(COLLECTION_NAME);

  // índice único em id (ignora erro se já existir)
  await collection.createIndex({ id: 1 }, { unique: true }).catch(() => {});

  isConnectedFlag = true;
  console.log("[MONGO] conectado em", DB_NAME, COLLECTION_NAME);
}

/* =========================
   Utilitários de data
========================= */

function parseValidadeAtNine(validade: string): Date {
  // validação mínima:
  if (!/^\d{4}-\d{2}-\d{2}$/.test(validade)) {
    // se quiser, lance erro em vez de usar new Date inválido
    return new Date(validade); // fallback
  }
  return new Date(`${validade}T09:00:00`);
}

function calcNotifyDate(validade: string, diasAntes: number): Date {
  const validadeDate = parseValidadeAtNine(validade);
  const notifyDate = new Date(validadeDate);
  notifyDate.setDate(validadeDate.getDate() - diasAntes);
  return notifyDate;
}

/* =========================
   Persistência em Mongo
========================= */

export async function loadAll(): Promise<Reminder[]> {
  if (!collection) await connectMongo();
  return (collection as Collection<Reminder>).find().toArray();
}

export async function saveReminder(reminder: Reminder) {
  if (!collection) await connectMongo();

  if (!reminder.createdAt) reminder.createdAt = new Date().toISOString();

  try {
    await (collection as Collection<Reminder>).insertOne(reminder);
    console.log(`[MONGO] Reminder salvo: ${reminder.id}`);
  } catch (err: any) {
    if (err?.code === 11000) {
      console.warn(`[MONGO] Reminder com id ${reminder.id} já existe. Ignorando insert.`);
    } else {
      throw err;
    }
  }

  // agenda depois de salvar
  await scheduleReminder(reminder);
}

/* =========================
   Agendamento com node-schedule
========================= */

export async function scheduleReminder(reminder: Reminder) {
  const notifyDate = calcNotifyDate(reminder.validade, reminder.diasAntes);

  if (notifyDate <= new Date()) {
    console.warn(
      `[REMINDER] Data já passou para ${reminder.produto} (${reminder.validade}) - notifyDate ${notifyDate.toISOString()}`
    );
    return;
  }

  // cancela job anterior com o mesmo id (se existir)
  // cast para any para evitar warning de índice em scheduledJobs
  const existing = (schedule.scheduledJobs as any)[reminder.id];
  if (existing) existing.cancel();

  schedule.scheduleJob(reminder.id, notifyDate, async () => {
    const text = `⏰ Lembrete: *${reminder.produto}* vence em ${reminder.validade}`;


    try {
      if (whatsappClient) {
        // chatId deve estar no formato aceito por whatsapp-web.js (ex: '5511999999999@c.us')
        await whatsappClient.sendMessage(reminder.chatId, text);

      } else {
        console.log(`[REMINDER] whatsappClient não anexado. Mensagem: ${text}`);
      }

      if (collection) {
        await collection.updateOne(
          { id: reminder.id },
          { $set: { sentAt: new Date().toISOString() } as any }
        ).catch(() => {});
      }
    } catch (err) {
      console.error(`[REMINDER] Erro ao enviar mensagem para ${reminder.chatId}:`, err);
      // aqui você pode incrementar um contador de tentativas, etc.
    }
  });

}

/* =========================
   Inicialização: carrega do mongo e agenda tudo
========================= */

export async function startScheduling() {
  await connectMongo();

  const todos = await loadAll();
  console.log(`[SCHEDULE] carregando ${todos.length} lembretes do Mongo para agendamento`);

  for (const r of todos) {
    try {
      await scheduleReminder(r);
    } catch (err) {
      console.error(`[SCHEDULE] erro ao agendar ${r.id}:`, err);
    }
  }
}

/* =========================
   Admin helpers
========================= */

export async function deleteReminderById(id: string) {
  if (!collection) await connectMongo();
  await (collection as Collection<Reminder>).deleteOne({ id });
  const job = (schedule.scheduledJobs as any)[id];
  if (job) job.cancel();
  console.log(`[MONGO] Reminder deletado e job cancelado: ${id}`);
}

export async function closeMongo() {
  if (client) {
    await client.close();
    client = null;
    db = null;
    collection = null;
    isConnectedFlag = false;
    console.log("[MONGO] conexão fechada");
  }
}
