// Изрично зареждаме .env файла и презаписваме съществуващите променливи
require('dotenv').config({ override: true });
const path = require('path');

// 1. Динамично зареждане на конфигурацията за автомобили от vehicles.js
let VEHICLES_CONFIG = [];
try {
    const configPath = path.resolve(__dirname, '../../vehicles.js');
    VEHICLES_CONFIG = require(configPath).VEHICLES_CONFIG || [];
} catch (err) {
    console.error('⚠️ Грешка при зареждане на vehicles.js:', err.message);
}

exports.handler = async (event, context) => {
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
        if (process.env.ACCESS_PASSWORD && body.password !== process.env.ACCESS_PASSWORD) {
            return {
                statusCode: 401,
                headers,
                body: JSON.stringify({ error: 'Грешна парола за достъп!' })
            };
        }
        let parsedData;
        if (body.isManual && body.manualData) {
            parsedData = body.manualData;
        } else {
            const rawKey = process.env.GEMINI_API_KEY || '';
            const apiKey = rawKey.trim().replace(/^["']|["']$/g, '');
            if (!apiKey) {
                throw new Error('Липсва GEMINI_API_KEY в environment променливите!');
            }
            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`;
            const parts = [];
            parts.push({
                text: `Ти си експерт по автоматизирано извличане на данни от изображения. Получаваш две снимки: едната е на табло на автомобил (километраж), а другата е касова бележка за гориво.
                Твоята задача е да ги анализираш, независимо от реда им, и да извлечеш следните данни в СТРИКТЕН JSON формат (без markdown):
                {
                  "odometer_total": (От снимката на таблото: ОБЩИЯТ пробег. Цяло число или null),
                  "odometer_trip": (От снимката на таблото: ДНЕВНИЯТ пробег 'Trip'. Десетично число или null),
                  "liters": (От касовата бележка: Количеството заредено ГОРИВО в литри. Десетично число или null),
                  "price_per_liter": (От касовата бележка: Извлечи ТОЧНАТА отпечатана числова стойност за 1 литър гориво. Взимай точните отпечатани числа БЕЗ да ги превалутираш и БЕЗ да ги делиш на 1.95583. Десетично число или null),
                  "discount": (От касовата бележка: Извлечи ТОЧНАТА отпечатана числова стойност за отстъпка. Взимай точните отпечатани числа БЕЗ да ги превалутираш и БЕЗ да ги делиш на 1.95583. Положително число или 0),
                  "total_amount": (От касовата бележка: Крайна платена сума. Извлечи ТОЧНАТА отпечатана числова стойност БЕЗ да я превалутираш и БЕЗ да я делиш на 1.95583. Десетично число или null),
                  "receipt_date": (От касовата бележка: Дата и час във формат "YYYY-MM-DD HH:mm". Стринг или null)
                }
                КРИТИЧНО ПРАВИЛО: Вземай ТОЧНО числовите стойности, отпечатани на бележката (напр. ако е отпечатано 0.63, върни 0.63; ако е отпечатано 1.87, върни 1.87). НИКОГА не делай стойностите на 1.95583 и НИКОГА не прави самоинициативни превалутирания между BGN и EUR!`
            });
            if (body.odometerImage && body.odometerImage.base64Data) {
                parts.push({ inlineData: { mimeType: body.odometerImage.mimeType, data: body.odometerImage.base64Data } });
            }
            if (body.receiptImage && body.receiptImage.base64Data) {
                parts.push({ inlineData: { mimeType: body.receiptImage.mimeType, data: body.receiptImage.base64Data } });
            }
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
            const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
            const cleanJsonText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
            parsedData = JSON.parse(cleanJsonText);
        }
        const selectedVehicleId = body.vehicle;
        const vehicleInfo = VEHICLES_CONFIG.find(v => v.id === selectedVehicleId) || {
            name: selectedVehicleId || "Автомобил",
            unit: "KM",
            conversionToKm: 1.0
        };
        const payloadToAppsScript = {
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
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                status: "success",
                sheet_status: scriptResponseStatus,
                data: scriptData.data || {},
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