/**
 * =====================================================================
 * BOT TELEGRAM PRO — SHEET E-COM & BORDEREAUX TR DELIVERY (ECOTRACK)
 * =====================================================================
 * Fonctionnalités majeures :
 * 1. Sheet E-com intégré : suivi des statuts (NRP 1, NRP 2, NRP 3, Confirmé, Annulé, Reporté, Expédié)
 * 2. Boutons d'actions interactifs sous chaque commande Telegram
 * 3. Création automatique de bordereau officiel TR Delivery (EcoTrack API)
 * 4. Envoi automatique du document PDF officiel dans le chat Telegram
 * 5. Dashboard Web interactif (http://localhost:3005/sheet)
 * 6. Export direct en fichier Excel / CSV (/export)
 * 7. Suivi des KPIs & performance des confirmateurs (/stats)
 * 8. Liste intelligente des rappels NRP (/nrp)
 * =====================================================================
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const ordersManager = require('./orders-manager.js');

// --- CONFIGURATION ---
const ECOTRACK_TOKEN = process.env.ECOTRACK_TOKEN || 'Nzt1PpVCh5YCrSTU6BAo2KOgJIPkMiMQmpiKiBdLCklK37WSJveblnZfEOGw';
const ECOTRACK_URL = process.env.ECOTRACK_URL || 'https://trdelivery.ecotrack.dz';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8857057256:AAGNk-1KOaDZQLcKOQPL0lObS7uMUBItOnk';
const HTTP_PORT = process.env.PORT || 3005;

// Charger les données de livraison (wilayas, communes, tarifs, bureaux)
let deliveryData = null;
try {
  const jsonPath = path.join(__dirname, 'delivery-data.json');
  if (fs.existsSync(jsonPath)) {
    deliveryData = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  }
} catch (e) {
  console.warn('Could not load delivery-data.json:', e.message);
}

const WILAYA_LOOKUP = {};
if (deliveryData && deliveryData.wilayas) {
  deliveryData.wilayas.forEach(w => {
    WILAYA_LOOKUP[w.id] = w;
    WILAYA_LOOKUP[w.code] = w;
    WILAYA_LOOKUP[w.nameFr.toLowerCase()] = w;
    WILAYA_LOOKUP[w.nameAr] = w;
  });
}

/**
 * Normalise le nom de commune pour correspondre à EcoTrack
 */
function normalizeCommune(rawCommune, wilayaId, isStopDesk) {
  if (!deliveryData || !deliveryData.communes) return (rawCommune || '').trim();

  const wCode = String(wilayaId).padStart(2, '0');
  const communes = deliveryData.communes[wCode] || [];
  const bureaux = (deliveryData.bureaux && deliveryData.bureaux[wCode]) || [];

  if (communes.length === 0) return (rawCommune || '').trim();

  const cleanRaw = (rawCommune || '')
    .toLowerCase()
    .replace(/^(bureau|stop\s*desk|مكتب|استلام من المكتب)\s*[:-]?\s*/i, '')
    .replace(/[éèêë]/g, 'e')
    .replace(/[àâä]/g, 'a')
    .replace(/[^a-z0-9]/g, '');

  for (const c of communes) {
    const cNorm = c.name.toLowerCase().replace(/[éèêë]/g, 'e').replace(/[àâä]/g, 'a').replace(/[^a-z0-9]/g, '');
    if (cNorm === cleanRaw) return c.name;
  }

  for (const c of communes) {
    const cNorm = c.name.toLowerCase().replace(/[éèêë]/g, 'e').replace(/[àâä]/g, 'a').replace(/[^a-z0-9]/g, '');
    if (cNorm.includes(cleanRaw) || cleanRaw.includes(cNorm)) return c.name;
  }

  if (isStopDesk && bureaux.length > 0) {
    for (const b of bureaux) {
      const bNorm = b.name.toLowerCase().replace(/[éèêë]/g, 'e').replace(/[àâä]/g, 'a').replace(/[^a-z0-9]/g, '');
      if (bNorm.includes(cleanRaw) || cleanRaw.includes(bNorm)) return b.name;
    }
    return bureaux[0].name;
  }

  const defaultCommune = communes.find(c => c.hasStopDesk) || communes[0];
  return defaultCommune ? defaultCommune.name : (rawCommune || '').trim();
}

/**
 * Parse un message de commande Telegram
 */
function parseOrderMessage(text) {
  const clean = text.replace(/<[^>]+>/g, '');

  const idMatch = clean.match(/(?:COMMANDE|ORDRE|CMD)\s*#?([A-Za-z0-9_]+)/i);
  const nameMatch = clean.match(/(?:الاسم|Nom)\s*:\s*([^\n\r]+)/i);
  const phoneMatch = clean.match(/(?:الهاتف|Phone|Tel)\s*:\s*([0-9\s\+\-\.]+)/i);
  const wilayaMatch = clean.match(/(?:الولاية|Wilaya)\s*:\s*([^\n\r]+)/i);
  const typeMatch = clean.match(/(?:نوع التوصيل|Mode)\s*:\s*([^\n\r]+)/i);
  const communeMatch = clean.match(/(?:البلدية|Commune)\s*:\s*([^\n\r]+)/i);
  const addressMatch = clean.match(/(?:العنوان|Adresse)\s*:\s*([^\n\r]+)/i);
  const bureauMatch = clean.match(/(?:المكتب|Bureau)\s*:\s*([^\n\r]+)/i);
  const offerMatch = clean.match(/(?:العرض|Offre)\s*:\s*([^\n\r]+)/i);
  const finishMatch = clean.match(/(?:المظهر|Finition)\s*:\s*([^\n\r]+)/i);
  const totalMatch = clean.match(/(?:المبلغ الإجمالي|Total)\s*:\s*([0-9\s]+)/i);

  const isStopDesk = (typeMatch && /مكتب|stop\s*desk/i.test(typeMatch[1])) || !!bureauMatch;

  let wilayaId = null;
  let wilayaName = '';
  if (wilayaMatch) {
    const rawW = wilayaMatch[1].trim();
    const num = rawW.match(/\b([0-9]{1,2})\b/);
    if (num) {
      wilayaId = parseInt(num[1], 10);
    } else {
      for (const [key, w] of Object.entries(WILAYA_LOOKUP)) {
        if (rawW.toLowerCase().includes(key.toLowerCase())) {
          wilayaId = w.id;
          break;
        }
      }
    }
    const foundW = WILAYA_LOOKUP[wilayaId];
    wilayaName = foundW ? `${foundW.code} - ${foundW.nameFr}` : rawW;
  }

  let phone = '';
  if (phoneMatch) {
    phone = phoneMatch[1].replace(/[\s\-\.\(\)]/g, '').replace(/^(\+213|00213)/, '0');
  }

  let montant = 0;
  if (totalMatch) {
    montant = parseInt(totalMatch[1].replace(/[\s\D]/g, ''), 10) || 0;
  }

  const rawCommune = communeMatch ? communeMatch[1].trim() : (bureauMatch ? bureauMatch[1].trim() : '');
  const exactCommune = normalizeCommune(rawCommune, wilayaId, isStopDesk);

  let adresse = '';
  if (isStopDesk) {
    adresse = bureauMatch ? `Bureau Stop Desk ${bureauMatch[1].trim()}` : `Bureau Stop Desk ${exactCommune}`;
  } else {
    adresse = addressMatch ? addressMatch[1].trim() : exactCommune;
  }

  const produit = offerMatch ? `${offerMatch[1].trim()} ${finishMatch ? finishMatch[1].trim() : ''}`.trim() : 'ميني فلوكون عطر';

  return {
    id: idMatch ? idMatch[1].trim() : null,
    nom_client: nameMatch ? nameMatch[1].trim() : '',
    telephone: phone,
    code_wilaya: wilayaId,
    wilaya_name: wilayaName,
    commune: exactCommune,
    adresse: adresse,
    montant: montant,
    stop_desk: isStopDesk ? 1 : 0,
    produit: produit,
    type: 1
  };
}

/**
 * Crée la commande sur l'API EcoTrack (TR Delivery)
 */
async function createEcoTrackOrder(order) {
  const payload = {
    nom_client: order.nom_client,
    telephone: order.telephone,
    adresse: order.adresse,
    code_wilaya: order.code_wilaya,
    commune: order.commune,
    montant: order.montant,
    type: 1, // Livraison
    stop_desk: order.stop_desk ? 1 : 0,
    produit: order.produit || 'ميني فلوكون عطر'
  };

  console.log('[EcoTrack] Création commande:', payload);

  const res = await fetch(`${ECOTRACK_URL}/api/v1/create/order`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ECOTRACK_TOKEN}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json().catch(() => ({}));

  if (res.status === 200 && data.success) {
    return {
      success: true,
      tracking: data.tracking,
      reference: data.reference,
      order: payload
    };
  }

  const errorMsg = data.message || (data.errors ? Object.values(data.errors).flat().join(', ') : 'Erreur inconnue');
  console.error('[EcoTrack] Échec:', res.status, errorMsg);
  return {
    success: false,
    status: res.status,
    message: errorMsg,
    errors: data.errors
  };
}

/**
 * Récupère l'URL directe du bordereau PDF depuis EcoTrack S3
 */
async function getOrderPdfUrl(tracking) {
  try {
    const res = await fetch(`${ECOTRACK_URL}/api/v1/get/order/label?tracking=${tracking}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${ECOTRACK_TOKEN}`,
        'Accept': 'application/json'
      },
      redirect: 'manual'
    });

    const location = res.headers.get('location');
    if (location && location.includes('.pdf')) {
      return location;
    }

    const html = await res.text();
    const match = html.match(/href=['"](https:\/\/[^'"]+\.pdf[^'"]*)['"]/i) ||
                  html.match(/content=['"][0-9]+;url=['"](https:\/\/[^'"]+\.pdf[^'"]*)['"]/i);
    if (match) return match[1];

    return null;
  } catch (err) {
    console.error('[EcoTrack] Erreur récupération label:', err.message);
    return null;
  }
}

/**
 * API Telegram wrapper
 */
async function telegramApi(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

/**
 * Répond à un Callback Query
 */
async function answerCallbackQuery(callbackQueryId, text, showAlert = false) {
  return telegramApi('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: text,
    show_alert: showAlert
  });
}

/**
 * Traite la création d'un bordereau depuis Telegram ou le Web
 */
async function handleCreateBordereau(orderId, chatId = null, messageId = null, user = 'Confirmateur') {
  let order = ordersManager.findOrder(orderId);

  if (!order) {
    if (chatId) {
      await telegramApi('sendMessage', {
        chat_id: chatId,
        text: `⚠️ Commande #${orderId} introuvable dans la base.`,
        parse_mode: 'HTML'
      });
    }
    return { success: false, message: 'Commande introuvable' };
  }

  // Si déjà expédié avec tracking
  if (order.tracking && order.pdf_url) {
    if (chatId) {
      await telegramApi('sendDocument', {
        chat_id: chatId,
        reply_to_message_id: messageId,
        document: order.pdf_url,
        caption: `ℹ️ <b>Bordereau déjà existant pour #${order.id} :</b>\n📦 Tracking : <code>${order.tracking}</code>`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🖨️ Ouvrir Bordereau PDF', url: order.pdf_url }],
            [{ text: '🔎 Suivi Colis', url: `https://suivi.ecotrack.dz/suivi/${order.tracking}` }]
          ]
        }
      });
    }
    return { success: true, tracking: order.tracking, pdf_url: order.pdf_url };
  }

  const created = await createEcoTrackOrder(order);

  if (!created.success) {
    if (chatId) {
      await telegramApi('sendMessage', {
        chat_id: chatId,
        reply_to_message_id: messageId,
        text: `❌ <b>Erreur création bordereau TR Delivery :</b>\n<code>${created.message}</code>`,
        parse_mode: 'HTML'
      });
    }
    return { success: false, message: created.message };
  }

  const tracking = created.tracking;
  const pdfUrl = await getOrderPdfUrl(tracking);

  // Mettre à jour l'ordre dans la base de données
  order = ordersManager.attachBordereau(order.id, tracking, pdfUrl, user);

  // Mettre à jour le message d'origine Telegram
  if (order.telegram_chat_id && order.telegram_message_id) {
    const updatedText = ordersManager.formatTelegramOrderMessage(order);
    const updatedKb = ordersManager.getOrderKeyboard(order);

    await telegramApi('editMessageText', {
      chat_id: order.telegram_chat_id,
      message_id: order.telegram_message_id,
      text: updatedText,
      parse_mode: 'HTML',
      reply_markup: updatedKb
    }).catch(() => {});
  }

  // Envoyer le document PDF officiel dans le chat Telegram
  if (chatId && pdfUrl) {
    await telegramApi('sendDocument', {
      chat_id: chatId,
      reply_to_message_id: messageId,
      document: pdfUrl,
      caption: `✅ <b>Bordereau TR Delivery Créé avec Succès !</b>\n` +
               `━━━━━━━━━━━━━━━━━━\n` +
               `📦 <b>N° Suivi (Tracking) :</b> <code>${tracking}</code>\n` +
               `👤 <b>Client :</b> ${order.nom_client}\n` +
               `📞 <b>Téléphone :</b> <code>${order.telephone}</code>\n` +
               `📍 <b>Destination :</b> ${order.wilaya_name || order.code_wilaya} - ${order.commune}\n` +
               `🚚 <b>Mode :</b> ${order.stop_desk ? 'استلام من المكتب (Stop Desk)' : 'توصيل للمنزل (À Domicile)'}\n` +
               `💰 <b>Montant à encaisser :</b> <b>${order.montant} DA</b>\n` +
               `━━━━━━━━━━━━━━━━━━\n` +
               `🖨️ Le PDF officiel est joint ci-dessus. Prêt à imprimer !`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🖨️ Ouvrir / Télécharger PDF', url: pdfUrl }],
          [{ text: '🔎 Suivi du Colis', url: `https://suivi.ecotrack.dz/suivi/${tracking}` }]
        ]
      }
    });
  }

  return { success: true, tracking, pdf_url: pdfUrl, order };
}

/**
 * Mise à jour de statut depuis Telegram (Callback Query)
 */
async function handleStatusCallback(cq, statusCode, orderId) {
  const user = cq.from ? (cq.from.first_name + (cq.from.last_name ? ' ' + cq.from.last_name : '')) : 'Confirmateur';
  const order = ordersManager.updateOrderStatus(orderId, statusCode, user);

  if (!order) {
    await answerCallbackQuery(cq.id, '❌ Commande introuvable', true);
    return;
  }

  const statusInfo = ordersManager.STATUTS[statusCode] || {};
  await answerCallbackQuery(cq.id, `✅ Statut mis à jour : ${statusInfo.labelFr} par ${user}`);

  // Mettre à jour le message d'origine dans Telegram
  if (cq.message) {
    const updatedText = ordersManager.formatTelegramOrderMessage(order);
    const updatedKb = ordersManager.getOrderKeyboard(order);

    await telegramApi('editMessageText', {
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      text: updatedText,
      parse_mode: 'HTML',
      reply_markup: updatedKb
    }).catch(err => console.warn('Edit msg notice:', err.message));
  }
}

/**
 * Serveur HTTP intégré pour le Dashboard Web Sheet Ecom Pro
 */
function startHttpServer() {
  const server = http.createServer(async (req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;

    // 1. DASHBOARD WEB : /sheet ou /
    if (pathname === '/sheet' || pathname === '/') {
      const sheetPath = path.join(__dirname, 'sheet.html');
      if (fs.existsSync(sheetPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        fs.createReadStream(sheetPath).pipe(res);
        return;
      }
    }

    // 2. API COMMANDES : GET /api/orders
    if (pathname === '/api/orders' && req.method === 'GET') {
      const db = ordersManager.loadDatabase();
      const kpis = ordersManager.getKpis();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ orders: db.orders, kpis }));
      return;
    }

    // 3. API CHANGEMENT STATUT : POST /api/orders/status
    if (pathname === '/api/orders/status' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { id, status, user, note } = JSON.parse(body);
          const updated = ordersManager.updateOrderStatus(id, status, user || 'Web Dashboard', note || '');
          if (!updated) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Commande introuvable' }));
            return;
          }

          // Si la commande a un message Telegram associé, on met à jour son affichage
          if (updated.telegram_chat_id && updated.telegram_message_id) {
            const updatedText = ordersManager.formatTelegramOrderMessage(updated);
            const updatedKb = ordersManager.getOrderKeyboard(updated);
            await telegramApi('editMessageText', {
              chat_id: updated.telegram_chat_id,
              message_id: updated.telegram_message_id,
              text: updatedText,
              parse_mode: 'HTML',
              reply_markup: updatedKb
            }).catch(() => {});
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, order: updated }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
      return;
    }

    // 4. API CRÉATION BORDEREAU DEPUIS WEB : POST /api/orders/bordereau
    if (pathname === '/api/orders/bordereau' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { id } = JSON.parse(body);
          const result = await handleCreateBordereau(id, null, null, 'Web Dashboard');
          res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
      return;
    }

    // 5. API EXPORT CSV : GET /api/export-csv
    if (pathname === '/api/export-csv') {
      const csv = ordersManager.generateCsv();
      const filename = `Sheet_Ecom_TR_Delivery_${new Date().toISOString().slice(0, 10)}.csv`;
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`
      });
      res.end(csv);
      return;
    }

    // 6. API RÉCEPTION COMMANDE SITE : POST /api/order
    if (pathname === '/api/order' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const orderData = JSON.parse(body);
          const saved = ordersManager.upsertOrder(orderData);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, id: saved.id }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.listen(HTTP_PORT, () => {
    console.log(`🌐 Dashboard Sheet Ecom Pro en ligne sur : http://localhost:${HTTP_PORT}/sheet`);
  });
}

/**
 * Boucle principale de réception Telegram (Long Polling)
 */
async function startBot() {
  console.log('🤖 Démarrage du Bot Telegram Sheet Ecom & TR Delivery...');
  console.log(`Plateforme EcoTrack: ${ECOTRACK_URL}`);

  let offset = 0;

  const me = await telegramApi('getMe', {});
  console.log(`✅ Connecté en tant que: @${me.result.username} (${me.result.first_name})`);

  await telegramApi('deleteWebhook', { drop_pending_updates: false });

  // Démarrage du serveur web local
  startHttpServer();

  while (true) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${offset}&timeout=25`, {
        signal: AbortSignal.timeout(30000)
      });
      const data = await res.json().catch(() => ({}));

      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          offset = update.update_id + 1;

          try {
            // ─────────────────────────────────────────────────────────────
            // 1. CLICS BOUTONS INLINE (CALLBACK QUERIES)
            // ─────────────────────────────────────────────────────────────
            if (update.callback_query) {
              const cq = update.callback_query;
              const cqData = cq.data || '';
              const msg = cq.message;
              const chatId = msg ? msg.chat.id : null;

              console.log(`[Telegram] Clic bouton: ${cqData}`);

              // A. Création du bordereau TR Delivery
              if (cqData.startsWith('create_bd_')) {
                const orderId = cqData.replace('create_bd_', '');
                await answerCallbackQuery(cq.id, '⏳ Création du bordereau en cours...');

                // S'assurer que la commande est enregistrée dans orders_db
                let order = ordersManager.findOrder(orderId);
                if (!order && msg && msg.text) {
                  const parsed = parseOrderMessage(msg.text);
                  parsed.id = orderId;
                  parsed.telegram_chat_id = chatId;
                  parsed.telegram_message_id = msg.message_id;
                  order = ordersManager.upsertOrder(parsed);
                }

                await handleCreateBordereau(orderId, chatId, msg ? msg.message_id : null, cq.from.first_name);
              }

              // B. Changements de statut confirmation
              else if (cqData.startsWith('st_confirme_')) {
                const orderId = cqData.replace('st_confirme_', '');
                await handleStatusCallback(cq, 'CONFIRME', orderId);
              }
              else if (cqData.startsWith('st_nrp1_')) {
                const orderId = cqData.replace('st_nrp1_', '');
                await handleStatusCallback(cq, 'NRP_1', orderId);
              }
              else if (cqData.startsWith('st_nrp2_')) {
                const orderId = cqData.replace('st_nrp2_', '');
                await handleStatusCallback(cq, 'NRP_2', orderId);
              }
              else if (cqData.startsWith('st_nrp3_')) {
                const orderId = cqData.replace('st_nrp3_', '');
                await handleStatusCallback(cq, 'NRP_3', orderId);
              }
              else if (cqData.startsWith('st_reporte_')) {
                const orderId = cqData.replace('st_reporte_', '');
                await handleStatusCallback(cq, 'REPORTE', orderId);
              }
              else if (cqData.startsWith('st_annule_')) {
                const orderId = cqData.replace('st_annule_', '');
                await handleStatusCallback(cq, 'ANNULE', orderId);
              }
              else if (cqData.startsWith('st_nouveau_')) {
                const orderId = cqData.replace('st_nouveau_', '');
                await handleStatusCallback(cq, 'NOUVEAU', orderId);
              }
              else if (cqData === 'bot_status') {
                await answerCallbackQuery(cq.id, '✅ Bot Sheet Ecom & TR Delivery 100% opérationnel !', true);
              }
              else if (cqData === 'export_csv_action') {
                await answerCallbackQuery(cq.id, '⏳ Génération du fichier Excel CSV...');
                const csvData = ordersManager.generateCsv();
                const filename = `Sheet_Ecom_TR_Delivery_${new Date().toISOString().slice(0, 10)}.csv`;
                const formData = new FormData();
                formData.append('chat_id', chatId);
                formData.append('caption', '📊 <b>Voici votre Sheet E-com complet au format Excel (CSV)</b>');
                formData.append('parse_mode', 'HTML');
                formData.append('document', new Blob([csvData], { type: 'text/csv' }), filename);

                await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`, {
                  method: 'POST',
                  body: formData
                });
              }
              else {
                await answerCallbackQuery(cq.id, 'Action reçue');
              }
            }

            // ─────────────────────────────────────────────────────────────
            // 2. MESSAGES TEXTES & COMMANDES
            // ─────────────────────────────────────────────────────────────
            if (update.message && update.message.text) {
              const msg = update.message;
              const text = msg.text.trim();
              const chatId = msg.chat.id;

              // Enregistrement automatique si c'est une notification de commande
              if (text.includes('طلب جديد') || text.includes('Nouvelle Commande') || text.includes('COMMANDE')) {
                const parsed = parseOrderMessage(text);
                if (parsed.nom_client && parsed.telephone) {
                  parsed.telegram_chat_id = chatId;
                  parsed.telegram_message_id = msg.message_id;
                  const saved = ordersManager.upsertOrder(parsed);
                  console.log(`[Orders DB] Commande enregistrée: #${saved.id} (${saved.nom_client})`);
                }
              }

              // A. COMMANDE /start ou /aide
              if (text.startsWith('/start') || text.startsWith('/aide') || text.startsWith('/help')) {
                await telegramApi('sendMessage', {
                  chat_id: chatId,
                  text: `📊 <b>BOT SHEET ECOM PRO & TR DELIVERY</b>\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `Ce bot suit tout le travail des confirmateurs et génère les bordereaux TR Delivery en 1 clic.\n\n` +
                        `<b>📋 Commandes du Sheet :</b>\n` +
                        `• <code>/sheet</code> : Affiche le tableau des commandes\n` +
                        `• <code>/sheet nrp</code> : Affiche uniquement les clients à rappeler (NRP)\n` +
                        `• <code>/sheet confirme</code> : Affiche les commandes confirmées\n` +
                        `• <code>/nrp</code> : Liste rapide des rappels à faire\n` +
                        `• <code>/kpi</code> ou <code>/stats</code> : Rapport complet (Taux de confirmation, CA, agents)\n` +
                        `• <code>/export</code> : Télécharge le fichier Excel / CSV officiel\n` +
                        `• <code>/recherche &lt;nom/tel&gt;</code> : Trouve une commande\n\n` +
                        `<b>📦 Commandes Bordereaux :</b>\n` +
                        `• Répondez à une commande avec <code>/bordereau</code>\n` +
                        `• <code>/suivi &lt;tracking&gt;</code> : Suivi du colis TR Delivery\n` +
                        `• <code>/tarifs &lt;wilaya&gt;</code> : Prix exacts domicile & stop desk\n\n` +
                        `🌐 <b>Dashboard Web :</b> <a href="http://localhost:${HTTP_PORT}/sheet">Ouvrir Sheet Ecom Pro</a>`,
                  parse_mode: 'HTML',
                  reply_markup: {
                    inline_keyboard: [
                      [
                        { text: '📥 Exporter Excel CSV', callback_data: 'export_csv_action' },
                        { text: 'ℹ️ Statut Bot', callback_data: 'bot_status' }
                      ]
                    ]
                  }
                });
              }

              // B. COMMANDE /sheet ou /commandes
              else if (text.startsWith('/sheet') || text.startsWith('/commandes')) {
                const subFilter = text.replace(/\/sheet|\/commandes/i, '').trim().toLowerCase();
                const db = ordersManager.loadDatabase();
                let orders = Object.values(db.orders).sort((a, b) => new Date(b.date) - new Date(a.date));

                if (subFilter === 'nrp') {
                  orders = orders.filter(o => o.statut.startsWith('NRP'));
                } else if (subFilter === 'confirme' || subFilter === 'confirmee') {
                  orders = orders.filter(o => o.statut === 'CONFIRME');
                } else if (subFilter === 'nouveau' || subFilter === 'nouvelle') {
                  orders = orders.filter(o => o.statut === 'NOUVEAU');
                } else if (subFilter === 'annule' || subFilter === 'annulee') {
                  orders = orders.filter(o => o.statut === 'ANNULE');
                }

                if (orders.length === 0) {
                  await telegramApi('sendMessage', {
                    chat_id: chatId,
                    text: `ℹ️ Aucune commande trouvée pour le filtre <b>${subFilter || 'Tous'}</b>.`,
                    parse_mode: 'HTML'
                  });
                } else {
                  const slice = orders.slice(0, 10);
                  let sheetText = `📋 <b>SHEET ECOM — COMMANDES (${orders.length})</b>\n━━━━━━━━━━━━━━━━━━\n`;

                  slice.forEach(o => {
                    const st = ordersManager.STATUTS[o.statut] || { badge: o.statut };
                    sheetText += `<b>#${o.id}</b> | ${st.badge}\n` +
                                 `👤 ${o.nom_client} | 📞 <code>${o.telephone}</code>\n` +
                                 `📍 ${o.wilaya_name || o.code_wilaya} | 💰 <b>${o.montant} DA</b>\n` +
                                 `──────────────────\n`;
                  });

                  if (orders.length > 10) {
                    sheetText += `<i>Affichage des 10 plus récentes sur ${orders.length}. Tapez /export pour le fichier Excel complet.</i>\n`;
                  }

                  await telegramApi('sendMessage', {
                    chat_id: chatId,
                    text: sheetText,
                    parse_mode: 'HTML',
                    reply_markup: {
                      inline_keyboard: [
                        [
                          { text: '📥 Exporter CSV (Excel)', callback_data: 'export_csv_action' }
                        ]
                      ]
                    }
                  });
                }
              }

              // C. COMMANDE /nrp (RAPPELS DU JOUR)
              else if (text.startsWith('/nrp') || text.startsWith('/rappels')) {
                const db = ordersManager.loadDatabase();
                const nrpOrders = Object.values(db.orders)
                  .filter(o => o.statut.startsWith('NRP'))
                  .sort((a, b) => new Date(b.date) - new Date(a.date));

                if (nrpOrders.length === 0) {
                  await telegramApi('sendMessage', {
                    chat_id: chatId,
                    text: '🎉 <b>Aucun client en NRP pour le moment !</b> Toutes les commandes sont traitées.',
                    parse_mode: 'HTML'
                  });
                } else {
                  let nrpText = `📞 <b>CLIENTS À RAPPELER (NRP : ${nrpOrders.length})</b>\n━━━━━━━━━━━━━━━━━━\n`;
                  nrpOrders.slice(0, 8).forEach(o => {
                    const st = ordersManager.STATUTS[o.statut] || {};
                    nrpText += `• <b>#${o.id}</b> : ${o.nom_client}\n` +
                               `  📞 <a href="tel:${o.telephone}">${o.telephone}</a> | 📍 ${o.wilaya_name || o.code_wilaya}\n` +
                               `  Statut : ${st.badge || o.statut} | 💰 ${o.montant} DA\n`;
                  });

                  await telegramApi('sendMessage', {
                    chat_id: chatId,
                    text: nrpText,
                    parse_mode: 'HTML',
                    reply_markup: {
                      inline_keyboard: [
                        [{ text: '📥 Exporter en CSV', callback_data: 'export_csv_action' }]
                      ]
                    }
                  });
                }
              }

              // D. COMMANDE /kpi ou /stats
              else if (text.startsWith('/kpi') || text.startsWith('/stats')) {
                const kpis = ordersManager.getKpis();

                let perfText = '';
                if (Object.keys(kpis.confirmateurStats).length > 0) {
                  perfText = `\n👥 <b>Performance Confirmateurs :</b>\n`;
                  Object.entries(kpis.confirmateurStats).forEach(([name, s]) => {
                    const rate = s.total > 0 ? ((s.confirmes / s.total) * 100).toFixed(0) : 0;
                    perfText += `• <b>${name}</b> : ${s.confirmes} confirmées (${rate}%) | ${s.nrp} NRP | ${s.annules} annulées\n`;
                  });
                }

                await telegramApi('sendMessage', {
                  chat_id: chatId,
                  text: `📊 <b>TABLEAU DE BORD CONFIRMATION COD</b>\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `📦 <b>Total Commandes :</b> ${kpis.total}\n` +
                        `🆕 <b>Nouvelles en attente :</b> ${kpis.nouveaux}\n` +
                        `🟢 <b>Confirmées :</b> <b>${kpis.confirmes} (${kpis.txConfirmation}%)</b>\n` +
                        `🟡 <b>NRP (Ne répond pas) :</b> ${kpis.nrp} (${kpis.txNrp}%)\n` +
                        `🔴 <b>Annulées :</b> ${kpis.annules} (${kpis.txAnnulation}%)\n` +
                        `🚚 <b>Expédiées (Bordereaux) :</b> ${kpis.expedies}\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `💰 <b>CA Confirmé :</b> <b>${kpis.caConfirme.toLocaleString()} DA</b>\n` +
                        `💵 <b>CA Potentiel Total :</b> ${kpis.caTotal.toLocaleString()} DA\n` +
                        perfText,
                  parse_mode: 'HTML',
                  reply_markup: {
                    inline_keyboard: [
                      [
                        { text: '📥 Télécharger Excel (CSV)', callback_data: 'export_csv_action' }
                      ]
                    ]
                  }
                });
              }

              // E. COMMANDE /export (FICHIER CSV EXCEL)
              else if (text.startsWith('/export') || text.startsWith('/csv') || text.startsWith('/excel')) {
                const csvData = ordersManager.generateCsv();
                const filename = `Sheet_Ecom_TR_Delivery_${new Date().toISOString().slice(0, 10)}.csv`;
                const tempFilePath = path.join(__dirname, filename);
                fs.writeFileSync(tempFilePath, csvData, 'utf-8');

                // Envoi via multipart ou URL locale
                const formData = new FormData();
                formData.append('chat_id', chatId);
                formData.append('caption', '📊 <b>Voici votre Sheet E-com complet au format Excel (CSV)</b>');
                formData.append('parse_mode', 'HTML');
                formData.append('document', new Blob([csvData], { type: 'text/csv' }), filename);

                await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`, {
                  method: 'POST',
                  body: formData
                });

                fs.unlink(tempFilePath, () => {});
              }

              // F. COMMANDE /recherche <nom ou tel>
              else if (text.startsWith('/recherche') || text.startsWith('/chercher') || text.startsWith('/find')) {
                const q = text.replace(/\/recherche|\/chercher|\/find/i, '').trim();
                if (!q) {
                  await telegramApi('sendMessage', {
                    chat_id: chatId,
                    text: 'Précisez le nom ou téléphone à chercher. Exemple : <code>/recherche 0555284211</code>',
                    parse_mode: 'HTML'
                  });
                } else {
                  const order = ordersManager.findOrder(q);
                  if (order) {
                    const cardText = ordersManager.formatTelegramOrderMessage(order);
                    const kb = ordersManager.getOrderKeyboard(order);
                    await telegramApi('sendMessage', {
                      chat_id: chatId,
                      text: cardText,
                      parse_mode: 'HTML',
                      reply_markup: kb
                    });
                  } else {
                    await telegramApi('sendMessage', {
                      chat_id: chatId,
                      text: `❌ Aucun client trouvé pour : <b>${q}</b>`,
                      parse_mode: 'HTML'
                    });
                  }
                }
              }

              // G. COMMANDE /bordereau ou /creer (PAR RÉPONSE À UN MESSAGE)
              else if ((text.startsWith('/bordereau') || text.startsWith('/creer') || text.startsWith('/colis')) && msg.reply_to_message) {
                const repliedText = msg.reply_to_message.text || msg.reply_to_message.caption || '';
                const parsed = parseOrderMessage(repliedText);
                let order = ordersManager.upsertOrder(parsed);
                await handleCreateBordereau(order.id, chatId, msg.message_id, msg.from.first_name);
              }

              // H. COMMANDE /suivi <tracking>
              else if (text.startsWith('/suivi')) {
                const trackingCode = text.replace('/suivi', '').trim();
                if (!trackingCode) {
                  await telegramApi('sendMessage', {
                    chat_id: chatId,
                    text: 'Veuillez préciser le numéro de tracking. Exemple : <code>/suivi EC3FVS26092728059</code>',
                    parse_mode: 'HTML'
                  });
                } else {
                  const pdfUrl = await getOrderPdfUrl(trackingCode);
                  await telegramApi('sendMessage', {
                    chat_id: chatId,
                    text: `🔎 <b>Suivi Colis TR Delivery :</b> <code>${trackingCode}</code>\n` +
                          `• Lien suivi public : <a href="https://suivi.ecotrack.dz/suivi/${trackingCode}">Voir sur Suivi EcoTrack</a>\n` +
                          (pdfUrl ? `• Bordereau PDF : <a href="${pdfUrl}">Télécharger le bordereau</a>` : ''),
                    parse_mode: 'HTML',
                    reply_markup: pdfUrl ? {
                      inline_keyboard: [
                        [{ text: '🖨️ Ouvrir le Bordereau PDF', url: pdfUrl }],
                        [{ text: '🔎 Suivi en Ligne', url: `https://suivi.ecotrack.dz/suivi/${trackingCode}` }]
                      ]
                    } : undefined
                  });
                }
              }

              // I. COMMANDE /tarifs <wilaya>
              else if (text.startsWith('/tarifs') || text.startsWith('/prix')) {
                const query = text.replace(/\/tarifs|\/prix/i, '').trim().toLowerCase();
                if (deliveryData && deliveryData.wilayas) {
                  let match = null;
                  if (query) {
                    match = deliveryData.wilayas.find(w =>
                      w.code === query ||
                      String(w.id) === query ||
                      w.nameFr.toLowerCase().includes(query) ||
                      w.nameAr.includes(query)
                    );
                  }

                  if (match) {
                    const fees = deliveryData.deliveryPrices[match.code] || { home: 'N/A', office: 'N/A' };
                    const bureaux = (deliveryData.bureaux && deliveryData.bureaux[match.code]) || [];
                    await telegramApi('sendMessage', {
                      chat_id: chatId,
                      text: `🚚 <b>Tarifs TR Delivery — Wilaya ${match.code} (${match.nameFr} - ${match.nameAr}) :</b>\n` +
                            `━━━━━━━━━━━━━━━━━━\n` +
                            `🏠 <b>À Domicile :</b> ${fees.home} DA\n` +
                            `🏢 <b>Stop Desk :</b> ${fees.office > 0 ? `${fees.office} DA` : 'Non disponible'}\n` +
                            `📍 <b>Bureaux Stop Desk :</b> ${bureaux.length > 0 ? bureaux.map(b => b.name).join(', ') : 'Aucun'}\n`,
                      parse_mode: 'HTML'
                    });
                  } else {
                    await telegramApi('sendMessage', {
                      chat_id: chatId,
                      text: `ℹ️ <b>Tapez /tarifs suivi du nom ou numéro de la wilaya.</b>\nExemple : <code>/tarifs Alger</code> ou <code>/tarifs 16</code>`,
                      parse_mode: 'HTML'
                    });
                  }
                }
              }
            }
          } catch (innerErr) {
            console.error('[Update Processing Error]:', innerErr);
          }
        }
      }
    } catch (err) {
      if (err.name !== 'TimeoutError') {
        console.error('[Telegram Polling Error]:', err.message);
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// Lancement du Bot
startBot().catch(err => {
  console.error('Fatal bot error:', err);
});
