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
        let parsedData = {
            odometer_total: null,
            odometer_trip: null,
            liters: null,
            price_per_liter: null,
            discount: 0,
            total_amount: null,
            receipt_date: null
        };
        const hasOdomImg = body.odometerImage && body.odometerImage.base64Data;
        const hasReceImg = body.receiptImage && body.receiptImage.base64Data;
        if (!body.isManual && (hasOdomImg || hasReceImg)) {
            const rawKey = process.env.GEMINI_API_KEY || '';
            const apiKey = rawKey.trim().replace(/^["']|["']$/g, '');
            if (!apiKey) {
                throw new Error('Липсва GEMINI_API_KEY в environment променливите!');
            }
            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`;
            const parts = [];
            let imageDescriptions = [];
            if (hasOdomImg) imageDescriptions.push("снимка на табло на автомобил (километраж)");
            if (hasReceImg) imageDescriptions.push("снимка на касова бележка за гориво");
            parts.push({
                text: `Ти си експерт по автоматизирано извличане на данни от изображения. Получаваш ${imageDescriptions.join(" и ")}.
                Твоята задача е да ги анализираш и да извлечеш наличните данни в СТРИКТЕН JSON формат (без markdown):
                {
                  "odometer_total": (От снимката на таблото: ОБЩИЯТ пробег. Цяло число или null),
                  "odometer_trip": (От снимката на таблото: ДНЕВНИЯТ пробег 'Trip'. Десетично число или null),
                  "liters": (От касовата бележка: Количеството заредено ГОРИВО в литри. Десетично число или null),
                  "price_per_liter": (От касовата бележка: Извлечи ТОЧНАТА отпечатана числова стойност за 1 литър гориво. Взимай точните отпечатани числа БЕЗ да ги превалутираш и БЕЗ да ги делиш на 1.95583. Десетично число или null),
                  "discount": (От касовата бележка: Извлечи ТОЧНАТА отпечатана числова стойност за отстъпка. Взимай точните отпечатани числа БЕЗ да ги превалутираш и БЕЗ да ги делиш на 1.95583. Положително число или 0),
                  "total_amount": (От касовата бележка: Крайна платена сума. Извлечи ТОЧНАТА отпечатана числова стойност БЕЗ да я превалутираш и БЕЗ да я делиш на 1.95583. Десетично число или null),
                  "receipt_date": (От касовата бележка: Дата и час във формат "YYYY-MM-DD HH:mm". Стринг или null)
                }
                КРИТИЧНО ПРАВИЛО: За полета, за които няма предоставена снимка, върни null. Вземай ТОЧНО числовите стойности, отпечатани на бележката (напр. ако е отпечатано 0.63, върни 0.63; ако е отпечатано 1.87, върни 1.87). НИКОГА не делай стойностите на 1.95583 и НИКОГА не прави самоинициативни превалутирания между BGN и EUR!`
            });
            if (hasOdomImg) {
                parts.push({ inlineData: { mimeType: body.odometerImage.mimeType, data: body.odometerImage.base64Data } });
            }
            if (hasReceImg) {
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
            const aiData = JSON.parse(cleanJsonText);
            Object.assign(parsedData, aiData);
        }
        if (body.manualData) {
            const manual = body.manualData;
            if (manual.odometer_total != null) parsedData.odometer_total = Number(manual.odometer_total);
            if (manual.odometer_trip != null) parsedData.odometer_trip = Number(manual.odometer_trip);
            if (manual.liters != null) parsedData.liters = Number(manual.liters);
            if (manual.price_per_liter != null) parsedData.price_per_liter = Number(manual.price_per_liter);
            if (manual.discount != null) parsedData.discount = Number(manual.discount);
            if (manual.total_amount != null) parsedData.total_amount = Number(manual.total_amount);
            if (manual.receipt_date) parsedData.receipt_date = manual.receipt_date;
        }
        if (parsedData.odometer_total != null) {
            const rawTot = Number(parsedData.odometer_total);
            if (!isNaN(rawTot) && rawTot <= 999 && body.prevOdometerTotal) {
                const prevTot = Number(body.prevOdometerTotal);
                if (!isNaN(prevTot)) {
                    let prefix = Math.floor(prevTot / 1000);
                    let candidate = prefix * 1000 + rawTot;
                    if (candidate < prevTot) {
                        prefix += 1;
                        candidate = prefix * 1000 + rawTot;
                    }
                    parsedData.odometer_total = candidate;
                }
            }
        }
        if (!parsedData.price_per_liter && parsedData.total_amount && parsedData.liters > 0) {
            parsedData.price_per_liter = Number((parsedData.total_amount / parsedData.liters).toFixed(2));
        }
        let calculatedData = body.calculatedData || {};
        let distance = 0;
        const tripVal = Number(parsedData.odometer_trip);
        const totVal = Number(parsedData.odometer_total);
        const prevTotVal = Number(body.prevOdometerTotal);
        if (!isNaN(tripVal) && tripVal > 0) {
            distance = tripVal;
        } else if (!isNaN(totVal) && !isNaN(prevTotVal) && totVal > prevTotVal) {
            distance = totVal - prevTotVal;
        }
        const litersVal = Number(parsedData.liters) || 0;
        const totalAmtVal = Number(parsedData.total_amount) || 0;
        const l_100 = distance > 0 ? (litersVal / distance) * 100 : (Number(calculatedData.liters_per_100km) || 0);
        const eur_100 = distance > 0 ? (totalAmtVal / distance) * 100 : (Number(calculatedData.euro_per_100km) || 0);
        const eur_km = distance > 0 ? (totalAmtVal / distance) : (Number(calculatedData.euro_per_km) || 0);
        calculatedData = {
            liters_per_100km: l_100.toFixed(2),
            euro_per_100km: eur_100.toFixed(2),
            euro_per_km: eur_km.toFixed(4),
            distance: distance > 0 ? distance.toFixed(1) + ' км' : (calculatedData.distance || null)
        };
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
            discount: parsedData.discount || 0,
            liters_per_100km: calculatedData.liters_per_100km,
            euro_per_100km: calculatedData.euro_per_100km,
            euro_per_km: calculatedData.euro_per_km
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
            try {
                scriptData = await sheetResponse.json();
            } catch (jsonErr) {
                scriptData = {};
            }
        }
        if (scriptData && scriptData.data) {
            const sd = scriptData.data;
            const sheetDist = sd.distance || sd.trip_distance || sd.calculated_distance || sd.distance_km;
            if (sheetDist) {
                calculatedData.distance = Number(sheetDist).toFixed(1) + ' км';
            }
            if (sd.liters_per_100km) calculatedData.liters_per_100km = String(sd.liters_per_100km);
            if (sd.euro_per_100km) calculatedData.euro_per_100km = String(sd.euro_per_100km);
            if (sd.euro_per_km) calculatedData.euro_per_km = String(sd.euro_per_km);
        }
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                status: "success",
                sheet_status: scriptResponseStatus,
                data: calculatedData,
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