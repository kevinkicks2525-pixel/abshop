/**
 * =====================================================================
 * GESTIONNAIRE DE BASE DE DONNÉES COMMANDES & SHEET E-COMMERCE
 * =====================================================================
 * Gère le cycle de vie complet des commandes COD :
 * - NOUVEAU, NRP 1, NRP 2, NRP 3, CONFIRMÉ, ANNULÉ, REPORTÉ, EXPÉDIÉ
 * - Historique horodaté des appels des confirmateurs
 * - Calcul des KPIs (Taux de confirmation, CA confirmé, Performance)
 * - Export CSV / Excel compatible Excel & Google Sheets (UTF-8 BOM)
 * =====================================================================
 */

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'orders_db.json');

// Définition des statuts et de leurs libellés / couleurs / icônes
const STATUTS = {
  NOUVEAU: {
    code: 'NOUVEAU',
    labelAr: 'جديد (لم يتم الاتصال)',
    labelFr: 'Nouveau',
    badge: '🆕 NOUVEAU',
    color: '#3b82f6'
  },
  NRP_1: {
    code: 'NRP_1',
    labelAr: 'لا يجيب - محاولة 1',
    labelFr: 'NRP 1 (1er Appel)',
    badge: '🟡 NRP 1 (Appel 1)',
    color: '#f59e0b'
  },
  NRP_2: {
    code: 'NRP_2',
    labelAr: 'لا يجيب - محاولة 2',
    labelFr: 'NRP 2 (2ème Appel)',
    badge: '🟠 NRP 2 (Appel 2)',
    color: '#d97706'
  },
  NRP_3: {
    code: 'NRP_3',
    labelAr: 'لا يجيب - محاولة 3',
    labelFr: 'NRP 3 (Dernier Appel)',
    badge: '🟤 NRP 3 (Injoignable)',
    color: '#b45309'
  },
  CONFIRME: {
    code: 'CONFIRME',
    labelAr: 'مؤكد',
    labelFr: 'Confirmé',
    badge: '🟢 CONFIRMÉ',
    color: '#10b981'
  },
  REPORTE: {
    code: 'REPORTE',
    labelAr: 'مؤجل / إعادة الاتصال',
    labelFr: 'Reporté / Rappeler',
    badge: '⏰ REPORTÉ',
    color: '#8b5cf6'
  },
  ANNULE: {
    code: 'ANNULE',
    labelAr: 'ملغى',
    labelFr: 'Annulé',
    badge: '🔴 ANNULÉ',
    color: '#ef4444'
  },
  EXPEDIE: {
    code: 'EXPEDIE',
    labelAr: 'تم إنشاء البوردرو / قيد الإرسال',
    labelFr: 'Expédié (Bordereau Créé)',
    badge: '🚚 EXPÉDIÉ',
    color: '#06b6d4'
  }
};

/**
 * Initialise ou charge la base de données
 */
function loadDatabase() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      const initialDb = { orders: {}, counter: 1 };
      fs.writeFileSync(DB_PATH, JSON.stringify(initialDb, null, 2), 'utf-8');
      return initialDb;
    }
    const data = fs.readFileSync(DB_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error('[Orders DB] Erreur chargement base:', err.message);
    return { orders: {}, counter: 1 };
  }
}

/**
 * Sauvegarde la base de données
 */
function saveDatabase(db) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('[Orders DB] Erreur sauvegarde base:', err.message);
    return false;
  }
}

/**
 * Enregistre ou met à jour une commande
 */
function upsertOrder(orderData) {
  const db = loadDatabase();
  const id = orderData.id || `CMD_${String(db.counter || 1).padStart(4, '0')}`;

  if (!orderData.id) {
    db.counter = (db.counter || 1) + 1;
  }

  const existing = db.orders[id] || {};
  const now = new Date();
  const dateStr = now.toLocaleDateString('fr-DZ') + ' ' + now.toLocaleTimeString('fr-DZ', { hour: '2-digit', minute: '2-digit' });

  const order = {
    id: id,
    date: existing.date || now.toISOString(),
    dateStr: existing.dateStr || dateStr,
    nom_client: orderData.nom_client || existing.nom_client || 'Inconnu',
    telephone: orderData.telephone || existing.telephone || '',
    code_wilaya: orderData.code_wilaya || existing.code_wilaya || null,
    wilaya_name: orderData.wilaya_name || existing.wilaya_name || '',
    commune: orderData.commune || existing.commune || '',
    adresse: orderData.adresse || existing.adresse || '',
    stop_desk: orderData.stop_desk !== undefined ? orderData.stop_desk : (existing.stop_desk || 0),
    mode: (orderData.stop_desk || existing.stop_desk) ? 'استلام من المكتب (Stop Desk)' : 'توصيل للمنزل (À Domicile)',
    produit: orderData.produit || existing.produit || 'ميني فلوكون عطر',
    montant: orderData.montant !== undefined ? orderData.montant : (existing.montant || 0),
    statut: orderData.statut || existing.statut || 'NOUVEAU',
    confirmateur: orderData.confirmateur || existing.confirmateur || null,
    notes: orderData.notes || existing.notes || '',
    tracking: orderData.tracking || existing.tracking || null,
    pdf_url: orderData.pdf_url || existing.pdf_url || null,
    telegram_message_id: orderData.telegram_message_id || existing.telegram_message_id || null,
    telegram_chat_id: orderData.telegram_chat_id || existing.telegram_chat_id || null,
    history: existing.history || [
      {
        action: 'CREATION',
        time: now.toISOString(),
        dateStr: dateStr,
        user: 'Site Web',
        text: 'Commande enregistrée depuis le site'
      }
    ]
  };

  db.orders[id] = order;
  saveDatabase(db);
  return order;
}

/**
 * Met à jour le statut d'une commande avec ajout à l'historique
 */
function updateOrderStatus(id, newStatus, user = 'Confirmateur', note = '') {
  const db = loadDatabase();
  const order = db.orders[id];
  if (!order) return null;

  const validStatus = STATUTS[newStatus] ? newStatus : 'NOUVEAU';
  const now = new Date();
  const dateStr = now.toLocaleDateString('fr-DZ') + ' ' + now.toLocaleTimeString('fr-DZ', { hour: '2-digit', minute: '2-digit' });

  const statusInfo = STATUTS[validStatus];
  let historyText = `Passé en ${statusInfo.badge}`;
  if (note) historyText += ` — Note: ${note}`;

  order.statut = validStatus;
  order.confirmateur = user;
  order.last_updated = now.toISOString();

  if (note) {
    order.notes = (order.notes ? order.notes + ' | ' : '') + note;
  }

  if (!order.history) order.history = [];
  order.history.push({
    action: validStatus,
    time: now.toISOString(),
    dateStr: dateStr,
    user: user,
    text: historyText
  });

  db.orders[id] = order;
  saveDatabase(db);
  return order;
}

/**
 * Associe le bordereau officiel EcoTrack à la commande
 */
function attachBordereau(id, tracking, pdfUrl, user = 'Bot') {
  const db = loadDatabase();
  const order = db.orders[id];
  if (!order) return null;

  const now = new Date();
  const dateStr = now.toLocaleDateString('fr-DZ') + ' ' + now.toLocaleTimeString('fr-DZ', { hour: '2-digit', minute: '2-digit' });

  order.tracking = tracking;
  order.pdf_url = pdfUrl;
  order.statut = 'EXPEDIE';
  order.last_updated = now.toISOString();

  if (!order.history) order.history = [];
  order.history.push({
    action: 'EXPEDIE',
    time: now.toISOString(),
    dateStr: dateStr,
    user: user,
    text: `Bordereau créé sur TR Delivery (Tracking: ${tracking})`
  });

  db.orders[id] = order;
  saveDatabase(db);
  return order;
}

/**
 * Met à jour la note / remarque d'une commande
 */
function updateOrderNote(id, note, user = 'Confirmateur') {
  const db = loadDatabase();
  const order = db.orders[id];
  if (!order) return null;

  const now = new Date();
  const dateStr = now.toLocaleDateString('fr-DZ') + ' ' + now.toLocaleTimeString('fr-DZ', { hour: '2-digit', minute: '2-digit' });

  order.notes = note;
  order.last_updated = now.toISOString();

  if (!order.history) order.history = [];
  order.history.push({
    action: 'NOTE',
    time: now.toISOString(),
    dateStr: dateStr,
    user: user,
    text: `Note mise à jour: ${note}`
  });

  db.orders[id] = order;
  saveDatabase(db);
  return order;
}

/**
 * Récupère une commande par ID ou par recherche (téléphone, tracking, nom)
 */
function findOrder(query) {
  const db = loadDatabase();
  if (db.orders[query]) return db.orders[query];

  const q = String(query).trim().toLowerCase();
  const qPhone = q.replace(/[^0-9]/g, '');

  for (const order of Object.values(db.orders)) {
    if (order.id.toLowerCase() === q) return order;
    if (order.tracking && order.tracking.toLowerCase() === q) return order;
    if (qPhone && order.telephone && order.telephone.includes(qPhone)) return order;
    if (order.nom_client && order.nom_client.toLowerCase().includes(q)) return order;
  }
  return null;
}

/**
 * Calcule tous les KPIs E-commerce de confirmation
 */
function getKpis() {
  const db = loadDatabase();
  const orders = Object.values(db.orders);

  const total = orders.length;
  let confirmes = 0;
  let nrp = 0;
  let annules = 0;
  let nouveaux = 0;
  let expedies = 0;
  let caTotal = 0;
  let caConfirme = 0;

  const confirmateurStats = {};

  orders.forEach(o => {
    const montant = Number(o.montant) || 0;
    caTotal += montant;

    if (o.statut === 'CONFIRME' || o.statut === 'EXPEDIE') {
      confirmes++;
      caConfirme += montant;
    }
    if (o.statut.startsWith('NRP')) nrp++;
    if (o.statut === 'ANNULE') annules++;
    if (o.statut === 'NOUVEAU') nouveaux++;
    if (o.statut === 'EXPEDIE') expedies++;

    if (o.confirmateur && o.confirmateur !== 'Site Web' && o.confirmateur !== 'Bot') {
      if (!confirmateurStats[o.confirmateur]) {
        confirmateurStats[o.confirmateur] = { total: 0, confirmes: 0, nrp: 0, annules: 0 };
      }
      confirmateurStats[o.confirmateur].total++;
      if (o.statut === 'CONFIRME' || o.statut === 'EXPEDIE') confirmateurStats[o.confirmateur].confirmes++;
      if (o.statut.startsWith('NRP')) confirmateurStats[o.confirmateur].nrp++;
      if (o.statut === 'ANNULE') confirmateurStats[o.confirmateur].annules++;
    }
  });

  const txConfirmation = total > 0 ? ((confirmes / total) * 100).toFixed(1) : '0';
  const txNrp = total > 0 ? ((nrp / total) * 100).toFixed(1) : '0';
  const txAnnulation = total > 0 ? ((annules / total) * 100).toFixed(1) : '0';

  return {
    total,
    nouveaux,
    confirmes,
    nrp,
    annules,
    expedies,
    caTotal,
    caConfirme,
    txConfirmation,
    txNrp,
    txAnnulation,
    confirmateurStats
  };
}

/**
 * Génère le fichier CSV (compatible Excel en UTF-8 BOM)
 */
function generateCsv() {
  const db = loadDatabase();
  const orders = Object.values(db.orders).sort((a, b) => new Date(b.date) - new Date(a.date));

  const headers = [
    'ID Commande',
    'Date',
    'Statut',
    'Nom Client',
    'Telephone',
    'Wilaya',
    'Commune',
    'Adresse',
    'Type Livraison',
    'Produit / Offre',
    'Montant Total (DA)',
    'Confirmateur',
    'Tracking TR Delivery',
    'Notes',
    'Historique des Appels'
  ];

  const rows = [headers];

  orders.forEach(o => {
    const statutInfo = STATUTS[o.statut] || { labelFr: o.statut };
    const historySummary = (o.history || [])
      .map(h => `[${h.dateStr}] ${h.user}: ${h.action}`)
      .join(' | ');

    rows.push([
      o.id,
      o.dateStr,
      statutInfo.labelFr,
      o.nom_client,
      `="${o.telephone}"`, // Format texte pour garder le 0 initial dans Excel
      o.wilaya_name || o.code_wilaya || '',
      o.commune,
      o.adresse,
      o.mode,
      o.produit,
      o.montant,
      o.confirmateur || '',
      o.tracking || '',
      o.notes || '',
      historySummary
    ]);
  });

  // Échappement CSV standard avec séparateur point-virgule (standard Excel FR)
  const csvContent = rows.map(row =>
    row.map(cell => {
      const str = String(cell == null ? '' : cell).replace(/"/g, '""');
      return `"${str}"`;
    }).join(';')
  ).join('\r\n');

  // Ajout du BOM UTF-8 (\uFEFF) pour qu'Excel ouvre immédiatement les caractères arabes et français sans problème d'encodage
  return '\uFEFF' + csvContent;
}

/**
 * Formate le texte complet du message Telegram pour une commande
 */
function formatTelegramOrderMessage(order) {
  const statutInfo = STATUTS[order.statut] || STATUTS.NOUVEAU;

  // Numéro WhatsApp propre
  const rawPhone = String(order.telephone || '').replace(/[^0-9]/g, '');
  const dzPhone = rawPhone.startsWith('0') ? '213' + rawPhone.slice(1) : rawPhone;

  let historyBlock = '';
  if (order.history && order.history.length > 1) {
    const recent = order.history.slice(-3); // 3 derniers événements
    historyBlock = `\n📝 <b>Historique récents :</b>\n` +
      recent.map(h => `• <i>${h.dateStr}</i> : <b>${h.action}</b> (${h.user})`).join('\n');
  }

  let trackingBlock = '';
  if (order.tracking) {
    trackingBlock = `\n📦 <b>Tracking TR Delivery :</b> <code>${order.tracking}</code>`;
  }

  return `🔔 <b>COMMANDE #${order.id}</b>
━━━━━━━━━━━━━━━━━━
👤 <b>الاسم :</b> ${order.nom_client}
📞 <b>الهاتف :</b> <code>${order.telephone}</code>
📍 <b>الولاية :</b> ${order.wilaya_name || order.code_wilaya}
🚚 <b>نوع التوصيل :</b> ${order.mode}
🏢 <b>التفاصيل :</b> ${order.adresse}
━━━━━━━━━━━━━━━━━━
🎁 <b>العرض :</b> ${order.produit}
💰 <b>المبلغ الإجمالي :</b> <b>${order.montant} دج</b>
━━━━━━━━━━━━━━━━━━
📊 <b>الحالة (Statut) :</b> <b>${statutInfo.badge}</b>
👤 <b>المسؤول (Confirmateur) :</b> ${order.confirmateur || 'En attente'}${trackingBlock}${historyBlock}
━━━━━━━━━━━━━━━━━━
📅 <b>التاريخ :</b> ${order.dateStr}`;
}

/**
 * Génère le clavier inline dynamique en fonction du statut de la commande
 */
function getOrderKeyboard(order) {
  const id = order.id;
  const rawPhone = String(order.telephone || '').replace(/[^0-9]/g, '');
  const waPhone = rawPhone.startsWith('0') ? '213' + rawPhone.slice(1) : rawPhone;
  const waUrl = `https://wa.me/${waPhone}`;

  const keyboard = [];

  // Boutons rapides d'action selon le statut
  if (order.statut === 'EXPEDIE') {
    // Si déjà expédié
    if (order.pdf_url) {
      keyboard.push([
        { text: '🖨️ Ouvrir Bordereau PDF', url: order.pdf_url }
      ]);
    }
    if (order.tracking) {
      keyboard.push([
        { text: `🔎 Suivi (${order.tracking})`, url: `https://suivi.ecotrack.dz/suivi/${order.tracking}` }
      ]);
    }
    keyboard.push([
      { text: '💬 WhatsApp', url: waUrl }
    ]);
  } else if (order.statut === 'CONFIRME') {
    // Si confirmé : bouton phare pour créer le bordereau
    keyboard.push([
      { text: '📄 Créer le Bordereau TR Delivery 🚀', callback_data: `create_bd_${id}` }
    ]);
    keyboard.push([
      { text: '❌ Annuler', callback_data: `st_annule_${id}` },
      { text: '⏰ Reporter', callback_data: `st_reporte_${id}` }
    ]);
    keyboard.push([
      { text: '💬 WhatsApp', url: waUrl },
      { text: '🔄 Remettre Nouveau', callback_data: `st_nouveau_${id}` }
    ]);
  } else if (order.statut === 'ANNULE') {
    // Si annulé
    keyboard.push([
      { text: '🔄 Réactiver / Confirmer', callback_data: `st_confirme_${id}` },
      { text: '💬 WhatsApp', url: waUrl }
    ]);
  } else {
    // Statut NOUVEAU ou NRP
    keyboard.push([
      { text: '✅ Confirmer', callback_data: `st_confirme_${id}` },
      { text: '❌ Annuler', callback_data: `st_annule_${id}` }
    ]);

    // Boutons NRP intelligents
    if (order.statut === 'NOUVEAU') {
      keyboard.push([
        { text: '📞 NRP 1 (1er Appel)', callback_data: `st_nrp1_${id}` },
        { text: '⏰ Reporter', callback_data: `st_reporte_${id}` }
      ]);
    } else if (order.statut === 'NRP_1') {
      keyboard.push([
        { text: '📞 NRP 2 (2ème Jour)', callback_data: `st_nrp2_${id}` },
        { text: '⏰ Reporter', callback_data: `st_reporte_${id}` }
      ]);
    } else {
      keyboard.push([
        { text: '📞 NRP 3 (Dernier)', callback_data: `st_nrp3_${id}` },
        { text: '⏰ Reporter', callback_data: `st_reporte_${id}` }
      ]);
    }

    keyboard.push([
      { text: '📄 Forcer Bordereau', callback_data: `create_bd_${id}` },
      { text: '💬 WhatsApp', url: waUrl }
    ]);
  }

  const publicUrl = process.env.PUBLIC_URL || 'https://3cf2e8b5a4c515.lhr.life';
  keyboard.push([
    { text: '📊 Ouvrir Sheet Ecom Pro', web_app: { url: `${publicUrl}/sheet` } }
  ]);

  return { inline_keyboard: keyboard };
}

module.exports = {
  STATUTS,
  loadDatabase,
  saveDatabase,
  upsertOrder,
  updateOrderStatus,
  updateOrderNote,
  attachBordereau,
  findOrder,
  getKpis,
  generateCsv,
  formatTelegramOrderMessage,
  getOrderKeyboard
};
