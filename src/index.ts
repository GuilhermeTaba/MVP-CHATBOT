// main.ts
import { Client, LocalAuth } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { attachConversationFlow } from './conversation-flow';
import dotenv from "dotenv";
dotenv.config();


// Cria o cliente com LocalAuth para salvar sessão automaticamente
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true, // mude para false para depurar com interface do Chromium
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--single-process'
    ]
  },
  // se o TypeScript reclamar, o cast as any já resolve
  webVersionCache: { type: 'none' } as any
});

// QR
client.on('qr', (qr: string) => {
  console.log('--- QR gerado. Escaneie com seu WhatsApp ---');
  qrcode.generate(qr, { small: true });
});

// Auth OK
client.on('authenticated', () => {
  console.log('Authenticated — sessão salva.');
});

// Auth falhou
client.on('auth_failure', (msg) => {
  console.error('Falha na autenticação:', msg);
});

// Ready
client.on('ready', () => {
  console.log('WhatsApp pronto (ready).');
  attachConversationFlow(client);
});

// Disconnected
client.on('disconnected', (reason) => {
  console.log('Desconectado:', reason);
});

// Erros do client
client.on('error', (err) => {
  console.error('Erro do client:', err);
});

// NÃO registre outro client.on('message') aqui — o conversation-flow já faz isso.

client.initialize();
