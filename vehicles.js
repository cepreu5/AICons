// CONFIGURATION: Списък с автомобили и технически параметри
const VEHICLES_CONFIG = [
    {
        id: "KIA_KM",
        name: "KIA",
        unit: "KM",             // Единица: Километри
        conversionToKm: 1.0     // 1 km = 1 km
    },
    {
        id: "SAAB_MILES",
        name: "SAAB",
        unit: "MILES",          // Единица: Мили
        conversionToKm: 1.60934 // 1 mile = 1.60934 km
    }
];

// Функция за динамично пълнене на <select> падащото меню
function loadVehicleOptions() {
    const select = document.getElementById('vehicle');
    if (!select) return;

    select.innerHTML = ''; // Изчистване на старите опции

    VEHICLES_CONFIG.forEach(v => {
        const option = document.createElement('option');
        option.value = v.id;
        option.textContent = `${v.name} (${v.unit})`;
        select.appendChild(option);
    });
}

if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', loadVehicleOptions);
}

// 🎯 ЕКСПОРТ ЗА NODE.JS (Netlify Functions)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { VEHICLES_CONFIG };
}