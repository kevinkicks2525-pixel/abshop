/**
 * =====================================================================
 * BOT TELEGRAM — GESTION DES BORDEREAUX TR DELIVERY (ECOTRACK)
 * =====================================================================
 * Fonctionnalités:
 * 1. Création de bordereaux en 1 clic via le bouton sous chaque commande
 * 2. Création de bordereau en répondant à un message avec /bordereau ou /creer
 * 3. Commande /suivi <tracking> pour suivre un colis
 * 4. Commande /tarifs <wilaya> pour consulter les prix officiels
 * 5. Commande /aide pour voir le menu
 * =====================================================================
 */

const fs = require('fs');
const path = require('path');

// --- CONFIGURATION ---
const ECOTRACK_TOKEN = process.env.ECOTRACK_TOKEN || 'Nzt1PpVCh5YCrSTU6BAo2KOgJIPkMiMQmpiKiBdLCklK37WSJveblnZfEOGw';
const ECOTRACK_URL = process.env.ECOTRACK_URL || 'https://trdelivery.ecotrack.dz';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8857057256:AAGNk-1KOaDZQLcKOQPL0lObS7uMUBItOnk';
const AUTHORIZED_CHATS = ['8716946287', '6419829363'];

// Charger les données de livraison (wilayas, communes, tarifs, bureaux)
let deliveryData = null;
try {
  const jsonPath = path.join(__dirname, 'delivery-data.json');
  if (fs.existsSync(jsonPath)) {
    deliveryData = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  }
} catch (e) {
  console.warn('Could not load delivery-data.json, will use fallback matching:', e.message);
}

// Map pour retrouver rapidement une wilaya par numéro ou nom
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
 * Nettoie une chaîne de texte (supprime balises HTML, espaces multiples)
 */
function cleanText(str) {
  return String(str || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalise un nom de commune pour correspondre exactement à la base EcoTrack
 */
function normalizeCommune(rawCommune, wilayaId, isStopDesk) {
  if (!deliveryData || !deliveryData.communes) return rawCommune.trim();

  const wCode = String(wilayaId).padStart(2, '0');
  const communes = deliveryData.communes[wCode] || [];
  const bureaux = (deliveryData.bureaux && deliveryData.bureaux[wCode]) || [];

  if (communes.length === 0) return rawCommune.trim();

  const cleanRaw = rawCommune
    .toLowerCase()
    .replace(/^(bureau|stop\s*desk|مكتب|استلام من المكتب)\s*[:-]?\s*/i, '')
    .replace(/[éèê]/g, 'e')
    .replace(/[àâ]/g, 'a')
    .replace(/[^a-z0-9]/g, '');

  // 1. Recherche exacte ou normalisée dans les communes de la wilaya
  for (const c of communes) {
    const cNorm = c.name.toLowerCase().replace(/[éèê]/g, 'e').replace(/[àâ]/g, 'a').replace(/[^a-z0-9]/g, '');
    if (cNorm === cleanRaw) return c.name;
  }

  // 2. Recherche partielle (ex: 'Dely Ibrahim' contient 'dely')
  for (const c of communes) {
    const cNorm = c.name.toLowerCase().replace(/[éèê]/g, 'e').replace(/[àâ]/g, 'a').replace(/[^a-z0-9]/g, '');
    if (cNorm.includes(cleanRaw) || cleanRaw.includes(cNorm)) return c.name;
  }

  // 3. Si stop_desk et bureau trouvé
  if (isStopDesk && bureaux.length > 0) {
    for (const b of bureaux) {
      const bNorm = b.name.toLowerCase().replace(/[éèê]/g, 'e').replace(/[àâ]/g, 'a').replace(/[^a-z0-9]/g, '');
      if (bNorm.includes(cleanRaw) || cleanRaw.includes(bNorm)) return b.name;
    }
    // Bureau par défaut: le premier bureau stop desk de la wilaya
    return bureaux[0].name;
  }

  // 4. Commune par défaut de la wilaya si non trouvé
  const defaultCommune = communes.find(c => c.hasStopDesk) || communes[0];
  return defaultCommune ? defaultCommune.name : rawCommune.trim();
}

/**
 * Analyse le texte d'un message Telegram pour en extraire tous les champs de commande
 */
function parseOrderMessage(text) {
  const clean = text.replace(/<[^>]+>/g, '');

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

  console.log('[EcoTrack] Création de la commande avec le payload:', payload);

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

  // En cas d'erreur de validation (422) ou autre
  const errorMsg = data.message || (data.errors ? Object.values(data.errors).flat().join(', ') : 'Erreur inconnue');
  console.error('[EcoTrack] Échec de création:', res.status, errorMsg);
  return {
    success: false,
    status: res.status,
    message: errorMsg,
    errors: data.errors
  };
}

/**
 * Récupère l'URL directe du bordereau PDF depuis l'API EcoTrack
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

    // EcoTrack renvoie une 302 Found avec Location vers le S3
    const location = res.headers.get('location');
    if (location && location.includes('.pdf')) {
      return location;
    }

    // Si le body contient l'URL de refresh
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
 * Envoie une réponse Telegram (API wrapper)
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
 * Répond à un Callback Query (toast alert Telegram)
 */
async function answerCallbackQuery(callbackQueryId, text, showAlert = false) {
  return telegramApi('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: text,
    show_alert: showAlert
  });
}

/**
 * Traite la demande de création de bordereau pour un message donné
 */
async function processBordereauCreation(chatId, messageText, originalMessageId = null, replyToId = null) {
  const order = parseOrderMessage(messageText);

  // Vérification des données indispensables
  if (!order.nom_client || !order.telephone || !order.code_wilaya || !order.commune) {
    await telegramApi('sendMessage', {
      chat_id: chatId,
      reply_to_message_id: replyToId || originalMessageId,
      text: `⚠️ <b>Données incomplètes pour créer le bordereau :</b>\n` +
            `• Client: ${order.nom_client || '❌ Manquant'}\n` +
            `• Téléphone: ${order.telephone || '❌ Manquant'}\n` +
            `• Wilaya: ${order.code_wilaya || '❌ Manquant'}\n` +
            `• Commune: ${order.commune || '❌ Manquant'}\n` +
            `• Montant: ${order.montant || '❌ Manquant'} DA\n\n` +
            `<i>Vérifiez que le message respecte le format standard.</i>`,
      parse_mode: 'HTML'
    });
    return;
  }

  // Message d'attente
  const waitingMsg = await telegramApi('sendMessage', {
    chat_id: chatId,
    reply_to_message_id: replyToId || originalMessageId,
    text: `⏳ <b>Création du bordereau TR Delivery en cours...</b>\n` +
          `👤 <b>Client:</b> ${order.nom_client}\n` +
          `📍 <b>Destination:</b> Wilaya ${order.code_wilaya} - ${order.commune}\n` +
          `🚚 <b>Mode:</b> ${order.stop_desk ? 'Stop Desk' : 'À Domicile'}\n` +
          `💰 <b>Montant:</b> ${order.montant} DA`,
    parse_mode: 'HTML'
  });

  const created = await createEcoTrackOrder(order);

  if (!created.success) {
    await telegramApi('editMessageText', {
      chat_id: chatId,
      message_id: waitingMsg.result.message_id,
      text: `❌ <b>Erreur lors de la création du bordereau :</b>\n<code>${created.message}</code>`,
      parse_mode: 'HTML'
    });
    return;
  }

  const tracking = created.tracking;
  const pdfUrl = await getOrderPdfUrl(tracking);

  // Supprime le message d'attente
  await telegramApi('deleteMessage', {
    chat_id: chatId,
    message_id: waitingMsg.result.message_id
  }).catch(() => {});

  // Envoi du document PDF directement si URL disponible
  if (pdfUrl) {
    await telegramApi('sendDocument', {
      chat_id: chatId,
      reply_to_message_id: replyToId || originalMessageId,
      document: pdfUrl,
      caption: `✅ <b>Bordereau TR Delivery Créé avec Succès !</b>\n` +
               `━━━━━━━━━━━━━━━━━━\n` +
               `📦 <b>N° Suivi (Tracking) :</b> <code>${tracking}</code>\n` +
               `👤 <b>Client :</b> ${order.nom_client}\n` +
               `📞 <b>Téléphone :</b> <code>${order.telephone}</code>\n` +
               `📍 <b>Destination :</b> ${order.wilaya_name || order.code_wilaya} - ${order.commune}\n` +
               `🚚 <b>Mode :</b> ${order.stop_desk ? 'استلام من المكتب (Stop Desk)' : 'توصيل للمنزل (À Domicile)'}\n` +
               `💰 <b>Montant :</b> <b>${order.montant} DA</b>\n` +
               `━━━━━━━━━━━━━━━━━━\n` +
               `🖨️ Le PDF officiel est joint ci-dessus. Prêt à imprimer !`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🖨️ Ouvrir / Télécharger PDF', url: pdfUrl }
          ],
          [
            { text: '🔎 Suivi du Colis', url: `https://suivi.ecotrack.dz/suivi/${tracking}` }
          ]
        ]
      }
    });
  } else {
    // Si PDF inaccessible, message texte avec tracking
    await telegramApi('sendMessage', {
      chat_id: chatId,
      reply_to_message_id: replyToId || originalMessageId,
      text: `✅ <b>Bordereau Créé avec Succès !</b>\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `📦 <b>N° Tracking :</b> <code>${tracking}</code>\n` +
            `👤 <b>Client :</b> ${order.nom_client}\n` +
            `💰 <b>Montant :</b> <b>${order.montant} DA</b>\n\n` +
            `🔗 <a href="https://trdelivery.ecotrack.dz">Accéder à la plateforme TR Delivery</a>`,
      parse_mode: 'HTML'
    });
  }

  // Si on a le message d'origine, on met à jour son bouton pour indiquer qu'il est déjà créé
  if (originalMessageId) {
    await telegramApi('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: originalMessageId,
      reply_markup: {
        inline_keyboard: [
          [
            { text: `✅ Bordereau Créé (${tracking})`, url: `https://suivi.ecotrack.dz/suivi/${tracking}` }
          ]
        ]
      }
    }).catch(() => {});
  }
}

/**
 * Boucle principale de réception des mises à jour Telegram (Long Polling)
 */
async function startBot() {
  console.log('🤖 Démarrage du Bot Telegram TR Delivery...');
  console.log(`Plateforme EcoTrack: ${ECOTRACK_URL}`);

  let offset = 0;

  // Récupération de l'identité du bot
  const me = await telegramApi('getMe', {});
  console.log(`✅ Connecté en tant que: @${me.result.username} (${me.result.first_name})`);

  // Supprime un éventuel webhook pour permettre le polling
  await telegramApi('deleteWebhook', { drop_pending_updates: false });

  while (true) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${offset}&timeout=25`, {
        signal: AbortSignal.timeout(30000)
      });
      const data = await res.json().catch(() => ({}));

      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          offset = update.update_id + 1;

          // 1. GESTION DU CLIC SUR BOUTON INLINE (CALLBACK QUERY)
          if (update.callback_query) {
            const cq = update.callback_query;
            const cqId = cq.id;
            const cqData = cq.data || '';
            const msg = cq.message;
            const chatId = msg ? msg.chat.id : null;

            console.log(`[Telegram] Clic bouton: ${cqData} de ${cq.from.first_name}`);

            if (cqData.startsWith('create_bd_') || cqData === 'create_bordereau') {
              await answerCallbackQuery(cqId, '⏳ Création du bordereau en cours...');
              if (msg && msg.text) {
                await processBordereauCreation(chatId, msg.text, msg.message_id);
              }
            } else if (cqData === 'bot_status') {
              await answerCallbackQuery(cqId, '✅ Le bot TR Delivery est en ligne et fonctionnel !', true);
            } else {
              await answerCallbackQuery(cqId, 'Action reçue');
            }
          }

          // 2. GESTION DES MESSAGES TEXTE & COMMANDES
          if (update.message && update.message.text) {
            const msg = update.message;
            const text = msg.text.trim();
            const chatId = msg.chat.id;

            // COMMANDE /aide ou /start
            if (text.startsWith('/start') || text.startsWith('/aide') || text.startsWith('/help')) {
              await telegramApi('sendMessage', {
                chat_id: chatId,
                text: `📦 <b>Bot Gestionnaire TR Delivery EcoTrack</b>\n` +
                      `━━━━━━━━━━━━━━━━━━\n` +
                      `Ce bot vous permet de générer vos bordereaux de livraison en 1 clic.\n\n` +
                      `<b>Comment l'utiliser :</b>\n` +
                      `1️⃣ <b>Bouton 1-clic :</b> Cliquez sur <code>[ 📄 Créer le Bordereau ]</code> sous chaque notification de commande.\n` +
                      `2️⃣ <b>Réponse à un message :</b> Répondez à n'importe quel message de commande avec <code>/bordereau</code> ou <code>/creer</code>.\n` +
                      `3️⃣ <b>Suivi de colis :</b> Envoyez <code>/suivi &lt;tracking&gt;</code> pour vérifier l'état d'un colis.\n` +
                      `4️⃣ <b>Tarifs officiels :</b> Envoyez <code>/tarifs &lt;wilaya&gt;</code> pour voir les prix exacts.\n` +
                      `━━━━━━━━━━━━━━━━━━\n` +
                      `✅ Connecté à <code>${ECOTRACK_URL}</code>`,
                parse_mode: 'HTML'
              });
            }

            // COMMANDE /bordereau ou /creer (PAR RÉPONSE À UN MESSAGE)
            else if ((text.startsWith('/bordereau') || text.startsWith('/creer') || text.startsWith('/colis')) && msg.reply_to_message) {
              const repliedText = msg.reply_to_message.text || msg.reply_to_message.caption || '';
              await processBordereauCreation(chatId, repliedText, msg.reply_to_message.message_id, msg.message_id);
            }

            // COMMANDE /suivi <tracking>
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

            // COMMANDE /tarifs <wilaya>
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
        }
      }
    } catch (err) {
      if (err.name !== 'TimeoutError') {
        console.error('[Telegram Polling Error]:', err.message);
      }
      // Petite pause en cas d'erreur réseau pour ne pas surcharger
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// Lancement automatique du bot
startBot().catch(err => {
  console.error('Fatal bot error:', err);
});
