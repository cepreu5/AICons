// Изрично зареждаме .env файла и презаписваме съществуващите променливи
require('dotenv').config({ override: true });
const path = require('path');

// 1. Динамично зареждане на конфигурацията за автомобили от vehicles.js
let VEHICLES_CONFIG = [];
try {
    // Папката е netlify/functions/, така че отиваме 2 нива нагоре за коренната папка
    const configPath = path.resolve(__dirname, '../../vehicles.js');
    VEHICLES_CONFIG = require(configPath).VEHICLES_CONFIG || [];
} catch (err) {
    console.error('⚠️ Грешка при зареждане на vehicles.js:', err.message);
}

exports.handler = async (event, context) => {
    // Разрешаваме CORS
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    try {
        const body = JSON.parse(event.body || '{}');

        // 2. Проверка на паролата за достъп
        if (process.env.ACCESS_PASSWORD && body.password !== process.env.ACCESS_PASSWORD) {
            return {
                statusCode: 401,
                headers,
                body: JSON.stringify({ error: 'Грешна парола за достъп!' })
            };
        }

        // 3. Подготовка на Gemini API
        const rawKey = process.env.GEMINI_API_KEY || '';
        const apiKey = rawKey.trim().replace(/^["']|["']$/g, '');

        if (!apiKey) {
            throw new Error('Липсва GEMINI_API_KEY в environment променливите!');
        }

        // const apiKey = process.env.GEMINI_API_KEY || '';
        console.log(`🔍 [BACKEND DEBUG] Прочитам API ключ, започващ с "${apiKey.substring(0, 4)}" и завършващ на "${apiKey.slice(-4)}"`);
        const geminiUrl =      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`;

        // 4. Подготовка на снимките за Gemini
        const parts = [];
        
        // Системен промпт
        parts.push({
            text: `Ти си експерт по автоматизирано извличане на данни от изображения. Получаваш две снимки: едната е на табло на автомобил (километраж), а другата е касова бележка за гориво.
            Твоята задача е да ги анализираш, независимо от реда им, и да извлечеш следните данни в СТРИКТЕН JSON формат (без markdown):
            {
              "odometer_total": (От снимката на таблото: ОБЩИЯТ пробег. Цяло число или null),
              "odometer_trip": (От снимката на таблото: ДНЕВНИЯТ пробег 'Trip'. Десетично число или null),
              "liters": (От касовата бележка: Количеството заредено ГОРИВО в литри. Десетично число или null),
              "price_per_liter": (От касовата бележка: Цена за 1 литър гориво в ЕВРО. Десетично число или null),
              "discount": (От касовата бележка: Отстъпка за горивото в ЕВРО. Положително число или 0),
              "total_amount": (От касовата бележка: Крайна платена сума в ЕВРО. Десетично число или null),
              "receipt_date": (От касовата бележка: Дата и час във формат "YYYY-MM-DD HH:mm". Стринг или null)
            }`
        });

        // Добавяме двете снимки, изпратени от фронтенда
        if (body.odometerImage && body.odometerImage.base64Data) {
            parts.push({ inlineData: { mimeType: body.odometerImage.mimeType, data: body.odometerImage.base64Data } });
        }
        if (body.receiptImage && body.receiptImage.base64Data) {
            parts.push({ inlineData: { mimeType: body.receiptImage.mimeType, data: body.receiptImage.base64Data } });
        }

        // 5. Заявка към Gemini API
        const geminiResponse = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts }],
                generationConfig: {
                    responseMimeType: "application/json"
                }
            })
        });

        const geminiData = await geminiResponse.json();

        if (!geminiResponse.ok) {
            throw new Error(`Gemini API върна грешка (${geminiResponse.status}): ${JSON.stringify(geminiData)}`);
        }

        // 6. Извличане и парсване на JSON отговора от Gemini
        const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        const cleanJsonText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        const parsedData = JSON.parse(cleanJsonText);

        // 7. Намиране на избрания автомобил от заредената конфигурация
        const selectedVehicleId = body.vehicle;
        const vehicleInfo = VEHICLES_CONFIG.find(v => v.id === selectedVehicleId) || {
            name: selectedVehicleId || "Автомобил",
            unit: "KM",
            conversionToKm: 1.0
        };

        // 8. Подготовка на обекта за Google Apps Script (само със сурови данни)
        const payloadToAppsScript = {
            // Използваме датата от бележката, ако съществува, иначе - текущата
            date: parsedData.receipt_date ? parsedData.receipt_date : new Date().toISOString().slice(0, 16).replace('T', ' '),
            vehicle_name: vehicleInfo.name,
            vehicle_unit: vehicleInfo.unit,
            odometer_total: parsedData.odometer_total,
            trip_distance: Number(parsedData.odometer_trip) || 0,
            liters: Number(parsedData.liters) || 0,
            price_per_liter: parsedData.price_per_liter,
            total_amount_eur: Number(parsedData.total_amount) || 0,
            discount: parsedData.discount || 0
        };

        // 9. Изпращане на данните към Google Apps Script (ако има зададен URL)
        let scriptResponseStatus = "skipped";
        let scriptData = {};
        if (process.env.GOOGLE_APPS_SCRIPT_URL) {
            const sheetResponse = await fetch(process.env.GOOGLE_APPS_SCRIPT_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payloadToAppsScript)
            });
            scriptResponseStatus = sheetResponse.ok ? "success" : "error";
            scriptData = await sheetResponse.json();
        }

        // 10. Връщане на успешен отговор към фронтенда
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                status: "success",
                sheet_status: scriptResponseStatus,
                // Връщаме целия обект с данни, който Apps Script е изчислил
                data: scriptData.data || {},
                // Добавяме и суровите данни от Gemini за целите на дебъга
                raw_data: parsedData
            })
        };

    } catch (error) {
        console.error('❌ Грешка във функцията:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message })
        };
    }
};
// exports.handler = async (event, context) => {
//     console.log('🚀 [BACKEND START] Заявката е получена в Netlify Function');

//     if (event.httpMethod !== 'POST') {
//         return { 
//             statusCode: 405, 
//             headers: { 'Content-Type': 'application/json' },
//             body: JSON.stringify({ error: 'Method Not Allowed' }) 
//         };
//     }

//     try {
//         const body = JSON.parse(event.body || '{}');

//         // 1. Проверка на паролата
//         console.log('🔍 [BACKEND STEP 1] Проверка на паролата...');
//         if (body.password !== process.env.ACCESS_PASSWORD) {
//             console.warn('⚠️ [BACKEND STEP 1] Грешна парола!');
//             return {
//                 statusCode: 401,
//                 headers: { 'Content-Type': 'application/json' },
//                 body: JSON.stringify({ error: 'Грешна парола за достъп!' })
//             };
//         }

//         const { vehicle, odometerImage, receiptImage } = body;

//         if (!odometerImage || !receiptImage) {
//             throw new Error('Липсват снимки в изпратените данни.');
//         }

//         // 2. Подготовка за Gemini
//         console.log('🔍 [BACKEND STEP 2] Подготовка на заявката към Gemini API...');
//         const promptText = `Ти си AI асистент за автоматизирано обработване на горивни бележки и километражи. Анализирай двете изображения: снимка на табло (километраж) и касова бележка за гориво.

// Твоята задача е да извлечеш данните и да ги върнеш ЕДИНСТВЕНО като чист JSON обект (без markdown форматиране като \`\`\`json), със следните ключове:
// {
//   "odometer_total": (ОБЩИЯТ пробег от таблото. Цяло число без десетични знаци, напр. 154200. Ако няма - 0),
//   "odometer_trip": (ДНЕВНИЯТ пробег 'Trip' от таблото. Десетично число, напр. 452.3. Ако няма - 0),
//   "liters": (Количеството заредено ГОРИВО в литри от бележката. Търси редове за Газ, Бензин, Дизел, LPG и т.н. Игнорирай стоки като течности за чистачки. Десетично число, напр. 62.19),
//   "price_per_liter": (Цена за 1 литър гориво ЗАДЪЛЖИТЕЛНО в ЕВРО (EUR / €). Десетично число, напр. 0.63),
//   "discount": (Стойност на отстъпката САМО за горивото ЗАДЪЛЖИТЕЛНО в ЕВРО (EUR / €), ако има. Върни я как ПОЛОЖИТЕЛНО десетично число, напр. 1.87. Ако няма - 0),
//   "total_amount": (Крайна платена сума САМО за горивото или общата сума ЗАДЪЛЖИТЕЛНО в ЕВРО (EUR / €). Десетично число, напр. 37.31. ИГНОРИРАЙ изцяло сумите в лева!),
//   "receipt_date": (Дата и час на транзакцията от бележката във формат "YYYY-MM-DD HH:mm", напр. "2026-07-20 10:27". Ако няма - null)
// }

// ЗАДЪЛЖИТЕЛНИ ПРАВИЛА:
// 1. ВАЛУТА: Всички парични суми (price_per_liter, discount, total_amount) ТРЯБВА ДА БЪДАТ В ЕВРО (EUR / €). НАПЪЛНО ИГНОРИРАЙ сумите, изписани в български лева (BGN / лв.).
// 2. Замествай всички десетични запетаи с точки (напр. 62,19 става 62.19).
// 3. Всички числови стойности трябва да са истински JSON числа (number), а не стрингове.
// 4. Ако на бележката има други стоки (напр. течност за чистачки, кафе), за 'liters', 'price_per_liter' и 'discount' вземай данните САМО от позицията за ГОРИВОТО.`;

//         const geminiPayload = {
//             contents: [{
//                 parts: [
//                     { text: promptText },
//                     { inlineData: { mimeType: odometerImage.mimeType, data: odometerImage.base64Data } },
//                     { inlineData: { mimeType: receiptImage.mimeType, data: receiptImage.base64Data } }
//                 ]
//             }],
//             generationConfig: {
//                 responseMimeType: "application/json"
//             }
//         };

//         // 3. Извикване на Gemini API
//         console.log('🚀 [BACKEND STEP 3] Изпращане към Gemini API...');
//         // const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`;

//         const apiKeyD = process.env.GEMINI_API_KEY || '';

//         // Диагностика: Извеждаме част от ключа, за да проверим дали се чете правилно
//         console.log(`🔍 [BACKEND DEBUG] Прочитам API ключ, започващ с "${apiKeyD.substring(0, 4)}" и завършващ на "${apiKeyD.slice(-4)}"`);


//         // ⚠️ ВРЕМЕНЕН ТЕСТ: Замести с твоя нов ключ в единични кавички
// const apiKey = '';
// const geminiUrl =      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`;

//         const geminiRes = await fetch(geminiUrl, {
//             method: 'POST',
//             headers: { 'Content-Type': 'application/json' },
//             body: JSON.stringify(geminiPayload)
//         });

//         const geminiRawText = await geminiRes.text();
//         console.log(`🌐 [BACKEND STEP 3] Gemini HTTP Status: ${geminiRes.status}`);
//         console.log(`📄 [BACKEND STEP 3] Gemini Raw Response:`, geminiRawText);

//         if (!geminiRes.ok) {
//             throw new Error(`Gemini API върна грешка (${geminiRes.status}): ${geminiRawText}`);
//         }

//         const geminiData = JSON.parse(geminiRawText);
//         const jsonText = geminiData.candidates[0].content.parts[0].text;
//         const parsedData = JSON.parse(jsonText);

//         parsedData.vehicle = vehicle;
//         parsedData.date = parsedData.receipt_date || new Date().toISOString().replace('T', ' ').substring(0, 16);

//         console.log('✅ [BACKEND STEP 3] Данни извлечени успешно от Gemini:', parsedData);

//         // 4. Изпращане към Google Apps Script
//         console.log('🚀 [BACKEND STEP 4] Изпращане към Google Apps Script...');
//         const sheetRes = await fetch(process.env.GOOGLE_APPS_SCRIPT_URL, {
//             method: 'POST',
//             headers: { 'Content-Type': 'application/json' },
//             body: JSON.stringify(parsedData)
//         });

//         const sheetRawText = await sheetRes.text();
//         console.log(`🌐 [BACKEND STEP 4] Google Apps Script HTTP Status: ${sheetRes.status}`);
//         console.log(`📄 [BACKEND STEP 4] Google Apps Script Raw Response:`, sheetRawText);

//         let sheetData = {};
//         try {
//             sheetData = JSON.parse(sheetRawText);
//         } catch (e) {
//             console.warn('⚠️ [BACKEND STEP 4] Google Apps Script не върна JSON, а текст:', sheetRawText);
//         }

//         // 5. Финален отговор
//         console.log('🏁 [BACKEND END] Успешно приключване на заявката!');
//         return {
//             statusCode: 200,
//             headers: { 'Content-Type': 'application/json' },
//             body: JSON.stringify({
//                 status: 'success',
//                 consumption: sheetData.consumption || null,
//                 parsedData: parsedData
//             })
//         };

//     } catch (error) {
//         console.error('💥 [BACKEND ERROR]:', error.message);
//         return {
//             statusCode: 500,
//             headers: { 'Content-Type': 'application/json' },
//             body: JSON.stringify({ error: error.message })
//         };
//     }
// };

// exports.handler = async (event, context) => {
//     // Разрешаваме само POST заявки
//     if (event.httpMethod !== 'POST') {
//         return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
//     }

//     try {
//         const body = JSON.parse(event.body);

//         // 1. Проверка на паролата срещу Environment Variable
//         if (body.password !== process.env.ACCESS_PASSWORD) {
//             return {
//                 statusCode: 401,
//                 body: JSON.stringify({ error: 'Грешна парола за достъп!' })
//             };
//         }

//         const { vehicle, odometerImage, receiptImage } = body;

//         // 2. Промпт за Gemini API
//         const promptText = `Ти си AI асистент за автоматизирано обработване на горивни бележки и километражи. Анализирай двете изображения: снимка на табло (километраж) и касова бележка за гориво.

//         Твоята задача е да извлечеш данните и да ги върнеш ЕДИНСТВЕНО като чист JSON обект (без markdown форматиране като \`\`\`json), със следните ключове:
//         {
//         "odometer_total": (ОБЩИЯТ пробег от таблото. Цяло число без десетични знаци, напр. 154200. Ако няма - 0),
//         "odometer_trip": (ДНЕВНИЯТ пробег 'Trip' от таблото. Десетично число, напр. 452.3. Ако няма - 0),
//         "liters": (Количеството заредено ГОРИВО в литри от бележката. Търси редове за Газ, Бензин, Дизел, LPG и т.н. Игнорирай стоки като течности за чистачки. Десетично число, напр. 62.19),
//         "price_per_liter": (Цена за 1 литър гориво ЗАДЪЛЖИТЕЛНО в ЕВРО (EUR / €). Десетично число, напр. 0.63),
//         "discount": (Стойност на отстъпката САМО за горивото ЗАДЪЛЖИТЕЛНО в ЕВРО (EUR / €), ако има. Върни я като ПОЛОЖИТЕЛНО десетично число, напр. 1.87. Ако няма - 0),
//         "total_amount": (Крайна платена сума САМО за горивото или общата сума ЗАДЪЛЖИТЕЛНО в ЕВРО (EUR / €). Десетично число, напр. 37.31. ИГНОРИРАЙ изцяло сумите в лева!),
//         "receipt_date": (Дата и час на транзакцията от бележката във формат "YYYY-MM-DD HH:mm", напр. "2026-07-20 10:27". Ако няма - null)
//         }

//         ЗАДЪЛЖИТЕЛНИ ПРАВИЛА:
//         1. ВАЛУТА: Всички парични суми (price_per_liter, discount, total_amount) ТРЯБВА ДА БЪДАТ В ЕВРО (EUR / €). НАПЪЛНО ИГНОРИРАЙ сумите, изписани в български лева (BGN / лв.).
//         2. Замествай всички десетични запетаи с точки (напр. 62,19 става 62.19).
//         3. Всички числови стойности трябва да са истински JSON числа (number), а не стрингове.
//         4. Ако на бележката има други стоки (напр. течност за чистачки, кафе), за 'liters', 'price_per_liter' и 'discount' вземай данните САМО от позицията за ГОРИВОТО.`;
//         const geminiPayload = {
//             contents: [{
//                 parts: [
//                     { text: promptText },
//                     { inlineData: { mimeType: odometerImage.mimeType, data: odometerImage.base64Data } },
//                     { inlineData: { mimeType: receiptImage.mimeType, data: receiptImage.base64Data } }
//                 ]
//             }],
//             generationConfig: {
//                 responseMimeType: "application/json"
//             }
//         };

//         // 3. Заявка към Google Gemini API
//         const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
//         const geminiRes = await fetch(geminiUrl, {
//             method: 'POST',
//             headers: { 'Content-Type': 'application/json' },
//             body: JSON.stringify(geminiPayload)
//         });

//         if (!geminiRes.ok) {
//             throw new Error(`Gemini API грешка: status ${geminiRes.status}`);
//         }

//         const geminiData = await geminiRes.json();
//         const jsonText = geminiData.candidates[0].content.parts[0].text;
//         const parsedData = JSON.parse(jsonText);

//         // Добавяме избрания автомобил и дата
//         parsedData.vehicle = vehicle;
//         parsedData.date = new Date().toISOString().replace('T', ' ').substring(0, 16);

//         // 4. Изпращане на данните към Google Apps Script (Микроуслугата за Google Sheet)
//         const sheetRes = await fetch(process.env.GOOGLE_APPS_SCRIPT_URL, {
//             method: 'POST',
//             headers: { 'Content-Type': 'application/json' },
//             body: JSON.stringify(parsedData)
//         });

//         const sheetData = await sheetRes.json();

//         // 5. Връщане на успешен отговор към Фронтенда
//         return {
//             statusCode: 200,
//             headers: { 'Content-Type': 'application/json' },
//             body: JSON.stringify({
//                 status: 'success',
//                 consumption: sheetData.consumption || null
//             })
//         };

//     } catch (error) {
//         return {
//             statusCode: 500,
//             body: JSON.stringify({ error: error.message })
//         };
//     }
// };