const fs = require('fs');
const path = require('path');

const token = 'Nzt1PpVCh5YCrSTU6BAo2KOgJIPkMiMQmpiKiBdLCklK37WSJveblnZfEOGw';
const url = 'https://trdelivery.ecotrack.dz';

// Arabic names for all wilayas
const WILAYA_AR_NAMES = {
  1: 'أدرار', 2: 'الشلف', 3: 'الأغواط', 4: 'أم البواقي', 5: 'باتنة', 6: 'بجاية', 7: 'بسكرة', 8: 'بشار',
  9: 'البليدة', 10: 'البويرة', 11: 'تمنراست', 12: 'تبسة', 13: 'تلمسان', 14: 'تيارت', 15: 'تيزي وزو',
  16: 'الجزائر', 17: 'الجلفة', 18: 'جيجل', 19: 'سطيف', 20: 'سعيدة', 21: 'سكيكدة', 22: 'سيدي بلعباس',
  23: 'عنابة', 24: 'قالمة', 25: 'قسنطينة', 26: 'المدية', 27: 'مستغانم', 28: 'المسيلة', 29: 'معسكر',
  30: 'ورقلة', 31: 'وهران', 32: 'البيض', 33: 'إليزي', 34: 'برج بوعريريج', 35: 'بومرداس', 36: 'الطارف',
  37: 'تندوف', 38: 'تيسمسيلت', 39: 'الوادي', 40: 'خنشلة', 41: 'سوق أهراس', 42: 'تيبازة', 43: 'ميلة',
  44: 'عين الدفلى', 45: 'النعامة', 46: 'عين تموشنت', 47: 'غرداية', 48: 'غليزان', 49: 'تيميمون',
  50: 'برج باجي مختار', 51: 'أولاد جلال', 52: 'بني عباس', 53: 'عين صالح', 54: 'عين قزام', 55: 'توقرت',
  56: 'جانت', 57: 'المغير', 58: 'المنيعة'
};

async function buildDeliveryData() {
  console.log('Fetching live data from TR Delivery EcoTrack API...');
  const [resW, resF, resC] = await Promise.all([
    fetch(url + '/api/v1/get/wilayas', { headers: { 'Authorization': 'Bearer ' + token } }).then(r => r.json()),
    fetch(url + '/api/v1/get/fees', { headers: { 'Authorization': 'Bearer ' + token } }).then(r => r.json()),
    fetch(url + '/api/v1/get/communes', { headers: { 'Authorization': 'Bearer ' + token } }).then(r => r.json())
  ]);

  // Map fees by wilaya_id
  const feesMap = {};
  resF.livraison.forEach(f => {
    feesMap[f.wilaya_id] = {
      home: parseInt(f.tarif, 10) || 0,
      office: parseInt(f.tarif_stopdesk, 10) || 0
    };
  });

  // Group communes and stopdesk bureaux by wilaya code (2 digits)
  const communesByWilaya = {};
  const bureauxByWilaya = {};

  Object.entries(resC).forEach(([id, c]) => {
    const wId = c.wilaya_id;
    const wCode = String(wId).padStart(2, '0');

    if (!communesByWilaya[wCode]) {
      communesByWilaya[wCode] = [];
    }
    if (!bureauxByWilaya[wCode]) {
      bureauxByWilaya[wCode] = [];
    }

    communesByWilaya[wCode].push({
      id: Number(id),
      name: c.nom.trim(),
      postalCode: c.code_postal || '',
      hasStopDesk: c.has_stop_desk === 1
    });

    if (c.has_stop_desk === 1) {
      bureauxByWilaya[wCode].push({
        id: Number(id),
        name: c.nom.trim(),
        address: 'مكتب Stop Desk - ' + c.nom.trim(),
        postalCode: c.code_postal || ''
      });
    }
  });

  // Sort communes and bureaux alphabetically
  Object.keys(communesByWilaya).forEach(wCode => {
    communesByWilaya[wCode].sort((a, b) => a.name.localeCompare(b.name));
    bureauxByWilaya[wCode].sort((a, b) => a.name.localeCompare(b.name));
  });

  // Wilayas list (sorted by id)
  const wilayasList = resW
    .map(w => {
      const code = String(w.wilaya_id).padStart(2, '0');
      return {
        id: w.wilaya_id,
        code: code,
        nameFr: w.wilaya_name.trim(),
        nameAr: WILAYA_AR_NAMES[w.wilaya_id] || w.wilaya_name.trim()
      };
    })
    .sort((a, b) => a.id - b.id);

  // Delivery prices keyed by 2-digit code
  const deliveryPrices = {};
  wilayasList.forEach(w => {
    deliveryPrices[w.code] = feesMap[w.id] || { home: 0, office: 0 };
  });

  console.log(`Extracted ${wilayasList.length} wilayas`);
  console.log(`Extracted communes for ${Object.keys(communesByWilaya).length} wilayas`);
  console.log(`Extracted stopdesks for ${Object.keys(bureauxByWilaya).filter(k => bureauxByWilaya[k].length > 0).length} wilayas`);

  const jsContent = `/**
 * Donnees officielles TR Delivery / EcoTrack
 * Plateforme: ${url}
 * Genere automatiquement le: ${new Date().toISOString()}
 */

window.DeliveryData = {
  provider: "TR Delivery (EcoTrack)",
  apiDomain: "${url}",
  lastUpdated: "${new Date().toISOString()}",
  wilayas: ${JSON.stringify(wilayasList, null, 2)},
  deliveryPrices: ${JSON.stringify(deliveryPrices, null, 2)},
  communes: ${JSON.stringify(communesByWilaya, null, 2)},
  bureaux: ${JSON.stringify(bureauxByWilaya, null, 2)}
};
`;

  const targetPath = path.join(__dirname, 'delivery-data.js');
  fs.writeFileSync(targetPath, jsContent, 'utf-8');
  console.log('Successfully wrote delivery-data.js! Size:', (jsContent.length / 1024).toFixed(2), 'KB');

  // Also save a JSON version for easy usage in node scripts / bot
  const jsonPath = path.join(__dirname, 'delivery-data.json');
  fs.writeFileSync(jsonPath, JSON.stringify({
    provider: "TR Delivery (EcoTrack)",
    apiDomain: url,
    lastUpdated: new Date().toISOString(),
    wilayas: wilayasList,
    deliveryPrices: deliveryPrices,
    communes: communesByWilaya,
    bureaux: bureauxByWilaya
  }, null, 2), 'utf-8');
  console.log('Successfully wrote delivery-data.json!');
}

buildDeliveryData().catch(console.error);
