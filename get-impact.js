#!/usr/bin/env node
'use strict';

const https = require('https');

// ---------------------------------------------------------------------------
// ANSI colours (disabled when not a TTY or NO_COLOR is set)
// ---------------------------------------------------------------------------
const COLOR_KEYS = ['reset','bold','dim','green','cyan','yellow','gray'];
const ANSI = { reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m', green:'\x1b[32m', cyan:'\x1b[36m', yellow:'\x1b[33m', gray:'\x1b[90m' };
const isColorEnabled = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const c = isColorEnabled ? ANSI : Object.fromEntries(COLOR_KEYS.map(k => [k, '']));

const SEP = c.dim + '─'.repeat(52) + c.reset;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRange(min, max, unit) {
    if (unit === 'kWh') {
        if      (max < 0.001) { min *= 1e6;  max *= 1e6;  unit = 'µWh'; }
        else if (max < 1)     { min *= 1000; max *= 1000; unit = 'Wh';  }
    } else if (unit === 'kgCO2eq') {
        if      (max < 0.0001) { min *= 1e6;  max *= 1e6;  unit = 'µg CO₂eq'; }
        else if (max < 0.1)    { min *= 1000; max *= 1000; unit = 'g CO₂eq';  }
    } else if (unit === 'MJ') {
        if (max < 1) { min *= 1000; max *= 1000; unit = 'kJ'; }
    } else if (unit === 'L') {
        if (max < 0.1) { min *= 1000; max *= 1000; unit = 'mL'; }
    }
    const dp = max >= 100 ? 1 : max >= 1 ? 2 : max >= 0.01 ? 3 : 4;
    return `${min.toFixed(dp)} \u2013 ${max.toFixed(dp)} ${unit}`;
}

function formatDuration(hours) {
    if (hours < 1) return `${Math.round(hours * 60)} min`;
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return m === 0 ? `${h}h` : `${h}h ${m}min`;
}

function postJson(urlStr, body) {
    return new Promise((resolve, reject) => {
        const data    = JSON.stringify(body);
        const urlObj  = new URL(urlStr);
        const options = {
            hostname: urlObj.hostname,
            path:     urlObj.pathname + urlObj.search,
            method:   'POST',
            headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        };
        const req = https.request(options, res => {
            let buf = '';
            res.on('data', c => buf += c);
            res.on('end', () => {
                try   { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
                catch { reject(new Error(`Failed to parse API response: ${buf}`)); }
            });
        });
        req.setTimeout(30000, () => req.destroy(new Error('EcoLogits API request timed out after 30s')));
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Calls the EcoLogits API and returns raw impact data (no printing).
 * Throws on network or API error.
 */
async function fetchImpact({ provider, modelName, outputTokens, zone = 'GBR', latency = 5.0 }) {
    let response;
    try {
        response = await postJson('https://api.ecologits.ai/v1beta/estimations', {
            provider,
            model_name:           modelName,
            output_token_count:   outputTokens,
            request_latency:      latency,
            electricity_mix_zone: zone,
        });
    } catch (e) {
        throw new Error(`EcoLogits API call failed: ${e.message}`);
    }

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`EcoLogits API returned HTTP ${response.status}`);
    }

    if (!response.body || !response.body.impacts) {
        throw new Error(`EcoLogits API returned unexpected response: ${JSON.stringify(response.body)}`);
    }

    const i = response.body.impacts;

    if (i.errors && i.errors.length > 0) {
        const msgs = i.errors.map(e => `[${e.code}] ${e.message}`).join('; ');
        throw Object.assign(new Error(`EcoLogits API errors: ${msgs}`), { provider, impacts: i });
    }

    return i;
}

/**
 * Sums an array of impact objects (same structure as returned by EcoLogits).
 * Units are taken from the first element; all elements must use the same units.
 */
function sumImpacts(impactsArray) {
    if (!impactsArray || impactsArray.length === 0) throw new Error('sumImpacts requires at least one element');
    if (impactsArray.length === 1) return impactsArray[0];
    return impactsArray.reduce((acc, i) => ({
        energy: { value: { min: acc.energy.value.min + i.energy.value.min, max: acc.energy.value.max + i.energy.value.max }, unit: acc.energy.unit },
        gwp:    { value: { min: acc.gwp.value.min    + i.gwp.value.min,    max: acc.gwp.value.max    + i.gwp.value.max    }, unit: acc.gwp.unit    },
        wcf:    { value: { min: acc.wcf.value.min    + i.wcf.value.min,    max: acc.wcf.value.max    + i.wcf.value.max    }, unit: acc.wcf.unit    },
        pe:     { value: { min: acc.pe.value.min     + i.pe.value.min,     max: acc.pe.value.max     + i.pe.value.max     }, unit: acc.pe.unit     },
        warnings: [...(acc.warnings || []), ...(i.warnings || [])],
    }));
}

/**
 * Prints a formatted impact summary.
 *
 * @param {object} opts
 * @param {object}   opts.impacts          Raw impacts object
 * @param {string}   opts.label            Header label (e.g. "This Copilot Session")
 * @param {string}   opts.modelName        Display model name (e.g. "claude-sonnet-4-6" or "3 models")
 * @param {string}   opts.provider         Display provider
 * @param {number}   opts.outputTokens     Total token count for subtitle
 * @param {string}   opts.zone             Electricity zone
 * @param {number}   [opts.carMPG=40]
 * @param {string}   [opts.fuelType=Diesel]
 * @param {number}   [opts.workstationWatts=150]
 * @param {string[]} [opts.breakdown]      Optional per-model lines to print after the main block
 */
function displayImpact({
    impacts,
    label            = 'This Copilot Session',
    modelName,
    provider,
    outputTokens,
    zone             = 'WOR',
    carEfficiency    = 40,
    carUnit          = 'mpg-uk', // 'mpg-uk' | 'mpg-us' | 'kpl' | 'l100km'
    fuelType         = 'Diesel',
    workstationWatts = 150,
    breakdown        = [],
    // Legacy alias kept for backward compatibility
    carMPG,
}) {
    if (carMPG !== undefined && carEfficiency === 40) carEfficiency = carMPG;
    const i = impacts;

    const energyStr = formatRange(i.energy.value.min, i.energy.value.max, i.energy.unit);
    const gwpStr    = formatRange(i.gwp.value.min,    i.gwp.value.max,    i.gwp.unit);
    const waterStr  = formatRange(i.wcf.value.min,    i.wcf.value.max,    i.wcf.unit);
    const peStr     = formatRange(i.pe.value.min,     i.pe.value.max,     i.pe.unit);

    const co2PerLitre = fuelType === 'Diesel' ? 2.68 : 2.31;
    let distMin, distMax, distLabel, efficiencyDesc;
    if (carUnit === 'mpg-us') {
        const co2PerMile = (3.78541 * co2PerLitre) / carEfficiency;
        distMin = (i.gwp.value.min / co2PerMile).toFixed(2);
        distMax = (i.gwp.value.max / co2PerMile).toFixed(2);
        distLabel      = 'miles';
        efficiencyDesc = `${carEfficiency} mpg US ${fuelType.toLowerCase()}`;
    } else if (carUnit === 'kpl') {
        const co2PerKm = co2PerLitre / carEfficiency;
        distMin = (i.gwp.value.min / co2PerKm).toFixed(2);
        distMax = (i.gwp.value.max / co2PerKm).toFixed(2);
        distLabel      = 'km';
        efficiencyDesc = `${carEfficiency} km/L ${fuelType.toLowerCase()}`;
    } else if (carUnit === 'l100km') {
        const co2PerKm = (carEfficiency / 100) * co2PerLitre;
        distMin = (i.gwp.value.min / co2PerKm).toFixed(2);
        distMax = (i.gwp.value.max / co2PerKm).toFixed(2);
        distLabel      = 'km';
        efficiencyDesc = `${carEfficiency} L/100km ${fuelType.toLowerCase()}`;
    } else {
        // mpg-uk (default)
        const co2PerMile = (4.54609 * co2PerLitre) / carEfficiency;
        distMin = (i.gwp.value.min / co2PerMile).toFixed(2);
        distMax = (i.gwp.value.max / co2PerMile).toFixed(2);
        distLabel      = 'miles';
        efficiencyDesc = `${carEfficiency} mpg UK ${fuelType.toLowerCase()}`;
    }

    const wsHoursMin = i.energy.value.min / (workstationWatts / 1000);
    const wsHoursMax = i.energy.value.max / (workstationWatts / 1000);

    const val = str => `${c.cyan}${str}${c.reset}`;
    const row = (emoji, lbl, value) => {
        const labelCol = (lbl + ':').padEnd(18);
        return `  ${emoji}  ${labelCol} ${val(value)}`;
    };

    console.log('');
    console.log(`${c.bold}${c.green}🌱 Environmental Impact \u2014 ${label}${c.reset}`);
    console.log(SEP);
    console.log(`${c.gray}  ${modelName}  \u00B7  ${provider}  \u00B7  ${outputTokens.toLocaleString()} tokens  \u00B7  ${zone}${c.reset}`);
    console.log('');
    console.log(row('⚡', 'Energy',         energyStr));
    console.log(row('🌡\u0020', 'CO\u2082 equivalent', gwpStr));
    console.log(row('💧', 'Water',           waterStr));
    console.log(row('🔋', 'Primary energy',  peStr));
    console.log('');

    if (breakdown.length > 0) {
        console.log(SEP);
        console.log(`${c.bold}  By model${c.reset}`);
        for (const line of breakdown) console.log(line);
        console.log('');
    }

    console.log(SEP);
    console.log(`${c.bold}  Real-world context${c.reset}`);
    console.log(`  🚗  CO\u2082 \u2248 ${val(`${distMin} \u2013 ${distMax} ${distLabel}`)} driven  ${c.gray}(${efficiencyDesc})${c.reset}`);
    console.log(`  🖥  Energy \u2248 ${val(`${formatDuration(wsHoursMin)} \u2013 ${formatDuration(wsHoursMax)}`)} workstation use  ${c.gray}(${workstationWatts}W)${c.reset}`);
    console.log('');

    const allWarnings = (i.warnings || []).filter((w, idx, arr) =>
        arr.findIndex(x => x.message === w.message) === idx);
    if (allWarnings.length > 0) {
        console.log(SEP);
        for (const w of allWarnings) {
            console.log(`${c.yellow}  \u26A0  ${w.message}${c.reset}`);
        }
        console.log('');
    }

    console.log(`${c.dim}  Inference only \u00B7 min\u2013max estimates \u00B7 ecologits.ai${c.reset}`);
    console.log(SEP);
    console.log('');
}

/**
 * Convenience wrapper: fetches impact from EcoLogits API and prints the summary.
 */
async function getImpact({
    provider,
    modelName,
    outputTokens,
    zone             = 'WOR',
    latency          = 5.0,
    carEfficiency    = 40,
    carUnit          = 'mpg-uk',
    fuelType         = 'Diesel',
    workstationWatts = 150,
    label            = 'This Copilot Session',
    // Legacy alias
    carMPG,
}) {
    if (carMPG !== undefined && carEfficiency === 40) carEfficiency = carMPG;
    let impacts;
    try {
        impacts = await fetchImpact({ provider, modelName, outputTokens, zone, latency });
    } catch (e) {
        if (e.impacts) {
            console.error('\n\u274C EcoLogits API returned errors:');
            for (const err of e.impacts.errors) console.error(`   \u2022 [${err.code}] ${err.message}`);
            console.error(`\nTip: list valid models with: curl https://api.ecologits.ai/v1beta/models/${provider}`);
        } else {
            console.error(e.message);
        }
        process.exit(1);
    }
    displayImpact({ impacts, label, modelName, provider, outputTokens, zone, carEfficiency, carUnit, fuelType, workstationWatts });
    return impacts;
}

// Runnable standalone: node get-impact.js --Provider <p> --ModelName <m> --OutputTokens <n> [options]
if (require.main === module) {
    const params = {};
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        const m = args[i].match(/^--?([^=]+)(?:=(.+))?$/);
        if (m) params[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : args[++i];
    }
    if (!params.provider || !params.modelname || params.outputtokens === undefined) {
        console.error('Usage: node get-impact.js --Provider <p> --ModelName <m> --OutputTokens <n>');
        process.exit(1);
    }
    getImpact({
        provider:         params.provider,
        modelName:        params.modelname,
        outputTokens:     parseInt(params.outputtokens, 10),
        zone:             params.zone             || 'WOR',
        latency:          parseFloat(params.latency          || '5.0'),
        carEfficiency:    parseFloat(params.carefficiency ?? params.carmpg ?? '40'),
        carUnit:          params.carunit          || 'mpg-uk',
        fuelType:         params.fueltype         || 'Diesel',
        workstationWatts: parseFloat(params.workstationwatts || '150'),
    }).catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { getImpact, fetchImpact, sumImpacts, displayImpact, formatRange, c };
