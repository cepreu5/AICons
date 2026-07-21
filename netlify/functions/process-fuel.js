exports.handler = async (event, context) => {
    console.log('🚀 [BACKEND START] Заявката е получена в Netlify Function');

    if (event.httpMethod !== 'POST') {
        return { 
            statusCode: 405, 
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Method Not Allowed' }) 
        };
    }

    try {
        const body = JSON.parse(event.body || '{}');

        // 1. Проверка на паролата
        console.log('🔍 [BACKEND STEP 1] Проверка на паролата...');
        if (body.password !== process.env.ACCESS_PASSWORD) {
            console.warn('⚠️ [BACKEND STEP 1] Грешна парола!');
            return {
                statusCode: 401,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Грешна парола за достъп!' })
            };
        }

        const { vehicle, odometerImage, receiptImage } = body;

        if (!odometerImage || !receiptImage) {
            throw new Error('Липсват снимки в изпратените данни.');
        }

        // 2. Подготовка за Gemini
        console.log('🔍 [BACKEND STEP 2] Подготовка на заявката към Gemini API...');
        const promptText = `Ти си AI асистент за автоматизирано обработване на горивни бележки и километражи. Анализирай двете изображения: снимка на табло (километраж) и касова бележка за гориво.

Твоята задача е да извлечеш данните и да ги върнеш ЕДИНСТВЕНО като чист JSON обект (без markdown форматиране като \`\`\`json), със следните ключове:
{
  "odometer_total": (ОБЩИЯТ пробег от таблото. Цяло число без десетични знаци, напр. 154200. Ако няма - 0),
  "odometer_trip": (ДНЕВНИЯТ пробег 'Trip' от таблото. Десетично число, напр. 452.3. Ако няма - 0),
  "liters": (Количеството заредено ГОРИВО в литри от бележката. Търси редове за Газ, Бензин, Дизел, LPG и т.н. Игнорирай стоки като течности за чистачки. Десетично число, напр. 62.19),
  "price_per_liter": (Цена за 1 литър гориво ЗАДЪЛЖИТЕЛНО в ЕВРО (EUR / €). Десетично число, напр. 0.63),
  "discount": (Стойност на отстъпката САМО за горивото ЗАДЪЛЖИТЕЛНО в ЕВРО (EUR / €), ако има. Върни я как ПОЛОЖИТЕЛНО десетично число, напр. 1.87. Ако няма - 0),
  "total_amount": (Крайна платена сума САМО за горивото или общата сума ЗАДЪЛЖИТЕЛНО в ЕВРО (EUR / €). Десетично число, напр. 37.31. ИГНОРИРАЙ изцяло сумите в лева!),
  "receipt_date": (Дата и час на транзакцията от бележката във формат "YYYY-MM-DD HH:mm", напр. "2026-07-20 10:27". Ако няма - null)
}

ЗАДЪЛЖИТЕЛНИ ПРАВИЛА:
1. ВАЛУТА: Всички парични суми (price_per_liter, discount, total_amount) ТРЯБВА ДА БЪДАТ В ЕВРО (EUR / €). НАПЪЛНО ИГНОРИРАЙ сумите, изписани в български лева (BGN / лв.).
2. Замествай всички десетични запетаи с точки (напр. 62,19 става 62.19).
3. Всички числови стойности трябва да са истински JSON числа (number), а не стрингове.
4. Ако на бележката има други стоки (напр. течност за чистачки, кафе), за 'liters', 'price_per_liter' и 'discount' вземай данните САМО от позицията за ГОРИВОТО.`;

        const geminiPayload = {
            contents: [{
                parts: [
                    { text: promptText },
                    { inlineData: { mimeType: odometerImage.mimeType, data: odometerImage.base64Data } },
                    { inlineData: { mimeType: receiptImage.mimeType, data: receiptImage.base64Data } }
                ]
            }],
            generationConfig: {
                responseMimeType: "application/json"
            }
        };

        // 3. Извикване на Gemini API
        console.log('🚀 [BACKEND STEP 3] Изпращане към Gemini API...');
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`;
        
        const geminiRes = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(geminiPayload)
        });

        const geminiRawText = await geminiRes.text();
        console.log(`🌐 [BACKEND STEP 3] Gemini HTTP Status: ${geminiRes.status}`);
        console.log(`📄 [BACKEND STEP 3] Gemini Raw Response:`, geminiRawText);

        if (!geminiRes.ok) {
            throw new Error(`Gemini API върна грешка (${geminiRes.status}): ${geminiRawText}`);
        }

        const geminiData = JSON.parse(geminiRawText);
        const jsonText = geminiData.candidates[0].content.parts[0].text;
        const parsedData = JSON.parse(jsonText);

        parsedData.vehicle = vehicle;
        parsedData.date = parsedData.receipt_date || new Date().toISOString().replace('T', ' ').substring(0, 16);

        console.log('✅ [BACKEND STEP 3] Данни извлечени успешно от Gemini:', parsedData);

        // 4. Изпращане към Google Apps Script
        console.log('🚀 [BACKEND STEP 4] Изпращане към Google Apps Script...');
        const sheetRes = await fetch(process.env.GOOGLE_APPS_SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(parsedData)
        });

        const sheetRawText = await sheetRes.text();
        console.log(`🌐 [BACKEND STEP 4] Google Apps Script HTTP Status: ${sheetRes.status}`);
        console.log(`📄 [BACKEND STEP 4] Google Apps Script Raw Response:`, sheetRawText);

        let sheetData = {};
        try {
            sheetData = JSON.parse(sheetRawText);
        } catch (e) {
            console.warn('⚠️ [BACKEND STEP 4] Google Apps Script не върна JSON, а текст:', sheetRawText);
        }

        // 5. Финален отговор
        console.log('🏁 [BACKEND END] Успешно приключване на заявката!');
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                status: 'success',
                consumption: sheetData.consumption || null,
                parsedData: parsedData
            })
        };

    } catch (error) {
        console.error('💥 [BACKEND ERROR]:', error.message);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: error.message })
        };
    }
};

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