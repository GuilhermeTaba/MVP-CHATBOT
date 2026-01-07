// main.ts
import dotenv from "dotenv";
dotenv.config();

import { v4 as uuidv4 } from 'uuid';
export const INSTANCE_ID = process.env.INSTANCE_ID || uuidv4();

// BOOT log — identifica processo/instância
console.log('[BOOT]', {
  time: new Date().toISOString(),
  pid: process.pid,
  instanceId: INSTANCE_ID,
  env: {
    RAILWAY_ENV: process.env.RAILWAY_ENV,
    RAILWAY_DEPLOYMENT_ID: process.env.RAILWAY_DEPLOYMENT_ID,
    RAILWAY_REGION: process.env.RAILWAY_REGION,
    NODE_ENV: process.env.NODE_ENV,
  }
});

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

/** Controle para garantir que o scheduler só inicia uma vez por processo */
let schedulerStarted = false;

/** Flag para evitar destruir/encerrar duas vezes */
let shuttingDown = false;

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
        backupSyncIntervalMs: 60_000,
      }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          // '--single-process', // opcional: experimente remover se estiver tendo crashes do Chromium
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

      // Inicia agendamentos — protegido para executar apenas uma vez por processo
      if (!schedulerStarted) {
        schedulerStarted = true;
        try {
          await startScheduling();
          console.log("[MAIN] startScheduling completo.");
        } catch (err) {
          console.error("[MAIN] Erro ao iniciar agendamento:", err);
          // se quiser permitir retry no mesmo processo:
          // schedulerStarted = false;
        }
      } else {
        console.log('[MAIN] ready disparou novamente — scheduler ignorado.');
      }

      // Inicia fluxo de conversa
      try {
        attachConversationFlow(client);
      } catch (err) {
        console.error('[MAIN] erro attachConversationFlow:', err);
      }
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
  if (shuttingDown) {
    console.log('[SHUTDOWN] já em andamento, ignorando nova chamada.');
    return;
  }
  shuttingDown = true;

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
    // delay curto pra garantir logs flush
    setTimeout(() => process.exit(0), 200);
  }
}

// Captura Promise rejections não tratadas
process.on('unhandledRejection', (reason, p) => {
  console.error('[unhandledRejection] motivo:', reason);
  // opcional: decide se quer encerrar. Por segurança, apenas logamos.
  // Se você preferir encerrar para evitar estado corrupto, chame gracefulShutdown('unhandledRejection')
});

// Captura exceções não tratadas — faz somente uma vez o gracefulShutdown
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  // tente um graceful shutdown, mas não aguarde indefinidamente aqui
  void gracefulShutdown('uncaughtException');
});

process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
