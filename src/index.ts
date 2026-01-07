// main.ts
import dotenv from "dotenv";
dotenv.config();

import { Client, RemoteAuth } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import mongoose from 'mongoose';
import { MongoStore } from 'wwebjs-mongo';
import { attachConversationFlow } from './conversation-flow';
import { startScheduling, attachWhatsAppClient } from "./reminders";

// Mongo URI garantida como string
const mongoUri: string = process.env.MONGO_KEY ?? '';
if (!mongoUri) {
  console.error("ERROR: MONGO_URI não está definida.");
  process.exit(1);
}

// Client WhatsApp (definite assignment)
let client!: Client;

/** Conexão única com Mongo */
async function ensureMongoConnected(): Promise<void> {
  if (mongoose.connection.readyState === 1) {
    const name = mongoose.connection.db?.databaseName ?? 'unknown';
    console.log(`[MONGO] já conectado (DB=${name}).`);
    return;
  }

  await mongoose.connect(mongoUri);
  const name = mongoose.connection.db?.databaseName ?? 'unknown';
  console.log(`[MONGO] conectado em ${name}`);
}

(async () => {
  try {
    // 1) Conectar ao Mongo antes de tudo
    await ensureMongoConnected();

    // 2) Store do WhatsApp (usa a MESMA instância mongoose)
    const store = new MongoStore({ mongoose });

    // 3) Cliente WhatsApp com RemoteAuth
    client = new Client({
      authStrategy: new RemoteAuth({
        store,
        clientId: 'default',
        backupSyncIntervalMs: 60_000, // pode manter
      }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--single-process',
          '--disable-gpu',
        ],
      },
      webVersionCache: { type: 'none' } as any,
    });

    // ===== Eventos =====

    client.on('qr', (qr: string) => {
      console.log('--- QR gerado. Escaneie com seu WhatsApp ---');
      qrcode.generate(qr, { small: true });
    });

    client.on('authenticated', () => {
      console.log('Authenticated — sessão validada.');
    });

    client.on('auth_failure', (msg) => {
      console.error('Falha na autenticação:', msg);
    });

    client.on('ready', async () => {
      console.log('WhatsApp pronto (ready).');

      // Disponibiliza client para reminders
      attachWhatsAppClient(client);

      // Inicia agendamentos
      try {
        await startScheduling();
        console.log("[MAIN] startScheduling completo.");
      } catch (err) {
        console.error("[MAIN] Erro ao iniciar agendamento:", err);
      }

      // Inicia fluxo de conversa
      attachConversationFlow(client);
    });

    client.on('disconnected', (reason) => {
      console.log('Desconectado:', reason);
    });

    client.on('error', (err) => {
      console.error('Erro do client:', err);
    });

    // Inicializa
    await client.initialize();
  } catch (err) {
    console.error("[MAIN] Erro ao conectar/inicializar:", err);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
  }
})();

// ===== Shutdown gracioso =====
async function gracefulShutdown(signal?: string) {
  try {
    console.log(`${signal ?? 'SIGINT'} recebido — finalizando...`);

    if (client) {
      try {
        await client.destroy();
        console.log('[MAIN] client WhatsApp destruído.');
      } catch (err) {
        console.warn('[MAIN] erro ao destruir client:', err);
      }
    }

    if (mongoose.connection.readyState === 1) {
      try {
        await mongoose.disconnect();
        console.log('[MONGO] desconectado com sucesso.');
      } catch (err) {
        console.warn('[MONGO] erro ao desconectar:', err);
      }
    }
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', async (err) => {
  console.error('Uncaught Exception:', err);
  await gracefulShutdown('uncaughtException');
});
