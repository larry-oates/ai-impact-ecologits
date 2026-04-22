#!/usr/bin/env node
'use strict';

/**
 * One-command environmental impact estimate for the current Copilot CLI session,
 * or for all sessions within a given time period.
 *
 * Usage:
 *   node run-impact.js [options]
 *
 * Options:
 *   --Model              Copilot model name (optional) — auto-detected from session events when available
 *   --SessionId          Override auto-detected session UUID (single-session mode only)
 *   --Days               Aggregate the last N days across all sessions (e.g. --Days 7)
 *   --Since              Start date for period query, inclusive (YYYY-MM-DD)
 *   --Until              End date for period query, inclusive (YYYY-MM-DD, default: today)
 *   --Zone               Electricity mix zone — ISO 3166-1 alpha-3 country code or WORLD (default: WORLD)
 *                        Examples: USA, DEU, FRA, AUS, JPN, GBR, IND, BRA
 *                        Full list: https://api.ecologits.ai/v1beta/electricity-mix-zones
 *   --CarEfficiency      Car fuel efficiency value (default: 40, unit set by --CarUnit)
 *   --CarUnit            Unit for --CarEfficiency: mpg-uk (default), mpg-us, kpl, l100km
 *   --CarMPG             Legacy alias for --CarEfficiency (UK mpg)
 *   --FuelType           Diesel or Petrol/Gasoline (default: Diesel)
 *   --WorkstationWatts   Dev workstation power draw in watts (default: 150)
 */

const fs   = require('fs');
const path = require('path');

const { getSessionTokens, getTokensForPeriod } = require('./get-session-tokens');
const { fetchImpact, sumImpacts, displayImpact, formatRange, c } = require('./get-impact');

// ---------------------------------------------------------------------------
// Parse arguments (case-insensitive, --Key value or --Key=value)
// ---------------------------------------------------------------------------
const params = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
    const m = args[i].match(/^--?([^=]+)(?:=(.+))?$/);
    if (m) params[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : args[++i];
}

// --Model is optional when model can be auto-detected from events; validated in Step 2 if needed

// ---------------------------------------------------------------------------
// Step 1: Resolve time period (if any) and get token counts
// ---------------------------------------------------------------------------

/** Parse a YYYY-MM-DD string to a Date at the start of that day (local midnight). */
function parseDate(str) {
    const m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) { console.error(`Invalid date format: "${str}" — expected YYYY-MM-DD`); process.exit(1); }
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

const isPeriodQuery = params.days || params.since || params.until;
const isManualMode  = params.outputtokens !== undefined;

let stats;
let periodLabel;

if (isManualMode) {
    // Manual mode: user supplies token count directly — works with any LLM tool
    const tokens = parseInt(params.outputtokens, 10);
    if (isNaN(tokens) || tokens < 1) {
        console.error('--OutputTokens must be a positive integer');
        process.exit(1);
    }
    stats       = { outputTokens: tokens, tokensByModel: {}, turnCount: 0, usedActualTokens: true, avgLatencySec: null };
    periodLabel = 'Manual Estimate';
} else if (isPeriodQuery) {
    let since = null;
    let until = null;

    if (params.days) {
        const days = parseInt(params.days, 10);
        if (isNaN(days) || days < 1) { console.error('--Days must be a positive integer'); process.exit(1); }
        since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        since.setHours(0, 0, 0, 0);
    } else if (params.since) {
        since = parseDate(params.since);
    }

    if (params.until) {
        until = parseDate(params.until);
        until.setHours(23, 59, 59, 999); // end of that day
    } else if (!params.days) {
        // open-ended: up to now
        until = new Date();
    } else {
        until = new Date(); // --Days N always ends now
    }

    try {
        stats = getTokensForPeriod({ since, until });
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    }

    // Build a human-readable label
    const fmt = d => d ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : null;
    if (params.days) {
        periodLabel = `Last ${params.days} Day${params.days === '1' ? '' : 's'}`;
    } else if (since && until) {
        periodLabel = `${fmt(since)} – ${fmt(until)}`;
    } else if (since) {
        periodLabel = `Since ${fmt(since)}`;
    } else {
        periodLabel = `Until ${fmt(until)}`;
    }
} else {
    try {
        stats = getSessionTokens(params.sessionid || null);
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    }
    periodLabel = 'This Copilot Session';
}

// ---------------------------------------------------------------------------
// Step 2: Build per-model token entries
// ---------------------------------------------------------------------------
const modelMapPath = path.join(__dirname, 'model-map.json');
const modelMap     = JSON.parse(fs.readFileSync(modelMapPath, 'utf8'));

function resolveMapping(copilotModelName) {
    const lower = copilotModelName.toLowerCase();
    let mapping = modelMap.find(m => m.copilot_model === lower)
               || modelMap.find(m => lower.startsWith(m.copilot_model));
    if (!mapping) {
        const fallback = params.model ? params.model.toLowerCase() : 'claude-sonnet-4.6';
        const fallbackLower = fallback.toLowerCase();
        const fallbackMapping = modelMap.find(m => m.copilot_model === fallbackLower)
                             || modelMap.find(m => fallbackLower.startsWith(m.copilot_model))
                             || { provider: 'anthropic', ecologits_model: 'claude-sonnet-4-6' };
        console.warn(`\u26A0\uFE0F  '${copilotModelName}' not found in model-map.json \u2014 falling back to ${fallbackMapping.ecologits_model}.`);
        return fallbackMapping;
    }
    return mapping;
}

// Build model entries: [{ copilotModel, tokens, provider, ecologits_model }]
let modelEntries;
const tokensByModel = stats.tokensByModel || {};
const knownModels   = Object.entries(tokensByModel).filter(([, t]) => t > 0);

if (knownModels.length > 0) {
    // Group 'unknown' tokens under the --Model fallback
    modelEntries = knownModels.map(([copilotModel, tokens]) => {
        const name    = copilotModel === 'unknown' ? (params.model || 'claude-sonnet-4.6') : copilotModel;
        const mapping = resolveMapping(name);
        return { copilotModel: name, tokens, ...mapping };
    });
} else {
    // No per-model data: fall back to --Model or the default
    const modelName = params.model || 'claude-sonnet-4.6';
    if (!params.model) {
        console.warn(`⚠️  No model data found in sessions — defaulting to ${modelName}. Use --Model to override.`);
    }
    const mapping = resolveMapping(modelName);
    modelEntries = [{ copilotModel: modelName, tokens: stats.outputTokens, ...mapping }];
}

const zone             = params.zone             || 'WOR';
const carEfficiency    = parseFloat(params.carefficiency ?? params.carmpg ?? '40');
const carUnit          = params.carunit          || 'mpg-uk';
const fuelType         = params.fueltype
    ? params.fueltype.charAt(0).toUpperCase() + params.fueltype.slice(1).toLowerCase()
    : 'Diesel';
const workstationWatts = parseFloat(params.workstationwatts ?? '150');
const latency          = stats.avgLatencySec ?? parseFloat(params.latency ?? '5.0');

const validCarUnits = ['mpg-uk', 'mpg-us', 'kpl', 'l100km'];
if (!validCarUnits.includes(carUnit)) {
    console.error(`--CarUnit must be one of: ${validCarUnits.join(', ')}. Got: "${params.carunit}"`);
    process.exit(1);
}
if (!['Diesel', 'Petrol', 'Gasoline'].includes(fuelType)) {
    console.error(`--FuelType must be "Diesel", "Petrol", or "Gasoline", got: "${params.fueltype}"`);
    process.exit(1);
}
if (isNaN(carEfficiency) || carEfficiency <= 0) {
    console.error('--CarEfficiency (or --CarMPG) must be a positive number');
    process.exit(1);
}
if (isNaN(workstationWatts) || workstationWatts <= 0) {
    console.error('--WorkstationWatts must be a positive number');
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 3: Fetch impact per model (in parallel), aggregate, and display
// ---------------------------------------------------------------------------
Promise.all(
    modelEntries.map(({ provider, ecologits_model, tokens }) =>
        fetchImpact({ provider, modelName: ecologits_model, outputTokens: tokens, zone, latency })
            .catch(e => {
                // surface errors with provider hint
                if (e.impacts) {
                    for (const err of e.impacts.errors) console.error(`   \u2022 [${err.code}] ${err.message}`);
                    console.error(`\nTip: curl https://api.ecologits.ai/v1beta/models/${provider}`);
                } else {
                    console.error(e.message);
                }
                process.exit(1);
            })
    )
).then(impacts => {
    const combined = impacts.length === 1 ? impacts[0] : sumImpacts(impacts);

    // Build per-model breakdown lines (only when there are multiple distinct models)
    const uniqueModels = [...new Set(modelEntries.map(e => e.ecologits_model))];
    const breakdown    = [];
    if (uniqueModels.length > 1) {
        for (let idx = 0; idx < modelEntries.length; idx++) {
            const e   = modelEntries[idx];
            const i   = impacts[idx];
            const eng = formatRange(i.energy.value.min, i.energy.value.max, i.energy.unit);
            const co2 = formatRange(i.gwp.value.min,    i.gwp.value.max,    i.gwp.unit);
            breakdown.push(`${c.gray}  • ${e.ecologits_model.padEnd(28)} ${e.tokens.toLocaleString().padStart(9)} tokens   ${eng}   ${co2}${c.reset}`);
        }
    }

    const displayModel    = uniqueModels.length === 1 ? modelEntries[0].ecologits_model : `${uniqueModels.length} models`;
    const displayProvider = uniqueModels.length === 1 ? modelEntries[0].provider        : 'combined';

    displayImpact({
        impacts:          combined,
        label:            periodLabel,
        modelName:        displayModel,
        provider:         displayProvider,
        outputTokens:     stats.outputTokens,
        zone,
        carEfficiency,
        carUnit,
        fuelType,
        workstationWatts,
        breakdown,
    });

    const tokenLabel   = stats.usedActualTokens ? '' : '~';
    const latencyLabel = stats.avgLatencySec != null ? `  \u00B7  avg ${stats.avgLatencySec.toFixed(1)}s latency` : '';
    if (isPeriodQuery) {
        const sessionsLabel = `${stats.sessionCount} session${stats.sessionCount === 1 ? '' : 's'}`;
        console.log(`${c.gray}  📊 ${sessionsLabel}  ·  ${stats.turnCount} turns  ·  ${tokenLabel}${stats.outputTokens.toLocaleString()} output tokens${latencyLabel}${c.reset}`);
    } else {
        console.log(`${c.gray}  📊 ${stats.turnCount} turns  ·  ${tokenLabel}${stats.outputTokens.toLocaleString()} output tokens${latencyLabel}${c.reset}`);
        console.log(`${c.gray}     Session: ${stats.sessionId}${c.reset}`);
    }
    console.log('');
}).catch(e => {
    console.error(e.message);
    process.exit(1);
});
