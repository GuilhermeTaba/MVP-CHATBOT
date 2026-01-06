// main.ts

import dotenv from "dotenv";
dotenv.config();
import { Client, LocalAuth } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { attachConversationFlow } from './conversation-flow';
import { startScheduling, attachWhatsAppClient } from "./reminders"; // <- importado



// Cria o cliente com LocalAuth para salvar sessão automaticamente
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--single-process'
    ]
  },
  webVersionCache: { type: 'none' } as any
});

// QR
client.on('qr', (qr: string) => {
  console.log('--- QR gerado. Escaneie com seu WhatsApp ---');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
  console.log('Authenticated — sessão salva.');
});

client.on('auth_failure', (msg) => {
  console.error('Falha na autenticação:', msg);
});

client.on('ready', async () => {
  console.log('WhatsApp pronto (ready).');

  // 1) anexa o client para que reminders.ts possa enviar mensagens
  attachWhatsAppClient(client);

  // 2) inicia o agendamento (carrega do Mongo e agenda todos os reminders)
  try {
    await startScheduling();
    console.log("[MAIN] startScheduling completo.");
  } catch (err) {
    console.error("[MAIN] Erro ao iniciar agendamento:", err);
  }

  // 3) anexa fluxo de conversa (seu handler de mensagens)
  attachConversationFlow(client);
});

client.on('disconnected', (reason) => {
  console.log('Desconectado:', reason);
});

client.on('error', (err) => {
  console.error('Erro do client:', err);
});

// NÃO registre outro client.on('message') aqui — o conversation-flow já faz isso.

client.initialize();

// opcional: fechar mongo ao encerrar o processo
process.on("SIGINT", async () => {
  console.log("SIGINT recebido — fechando...");
  // se quiser, importe closeMongo e chamar aqui
  process.exit(0);
});
