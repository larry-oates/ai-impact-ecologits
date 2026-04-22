#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ---------------------------------------------------------------------------
// Shared helper: accumulates tokens, turn count, and per-model breakdown
// from an array of parsed event objects.
// ---------------------------------------------------------------------------

/**
 * Processes a list of events and returns token/turn/model statistics.
 * Model is detected from tool.execution_complete events (which carry a
 * "model" field) and attributed to the tokens produced in the same turn.
 *
 * @param {object[]} events
 * @returns {{ tokensByModel, outputTokens, turnCount, usedActualTokens, avgLatencySec }}
 */
function accumulateTokens(events) {
    const tokensByModel  = {};
    let totalTokens      = 0;
    let turnCount        = 0;
    let usedActualTokens = false;
    const latenciesSec   = [];

    // Per-turn state
    let turnTokens        = 0;
    let turnUsedActual    = false;
    let turnModel         = null;
    let lastTurnStart     = null;

    for (const event of events) {
        if (event.type === 'assistant.turn_start') {
            // Reset per-turn accumulators
            turnTokens     = 0;
            turnUsedActual = false;
            turnModel      = null;
            lastTurnStart  = event.timestamp;
        } else if (event.type === 'tool.execution_complete' && event.data && event.data.model) {
            // First model we see in this turn wins
            if (!turnModel) turnModel = event.data.model;
        } else if (event.type === 'assistant.message' && event.data) {
            // Measure model-only latency: turn_start → assistant.message
            if (lastTurnStart && event.timestamp) {
                const secs = (new Date(event.timestamp) - new Date(lastTurnStart)) / 1000;
                if (secs > 0) latenciesSec.push(secs);
                lastTurnStart = null;
            }
            if (typeof event.data.outputTokens === 'number') {
                turnTokens    += event.data.outputTokens;
                turnUsedActual = true;
            } else if (!turnUsedActual) {
                let chars = (event.data.content || '').length;
                if (event.data.toolRequests) {
                    for (const req of event.data.toolRequests) {
                        if (req.arguments) chars += JSON.stringify(req.arguments).length;
                    }
                }
                turnTokens += Math.round(chars / 4);
            }
        } else if (event.type === 'assistant.turn_end') {
            const model = turnModel || 'unknown';
            tokensByModel[model] = (tokensByModel[model] || 0) + turnTokens;
            totalTokens += turnTokens;
            if (turnUsedActual) usedActualTokens = true;
            turnCount++;
        }
    }

    const avgLatencySec = latenciesSec.length > 0
        ? latenciesSec.reduce((a, b) => a + b, 0) / latenciesSec.length
        : null;

    return { tokensByModel, outputTokens: totalTokens, turnCount, usedActualTokens, avgLatencySec };
}

/**
 * Detects the active Copilot CLI session and counts output tokens from events.jsonl.
 * @param {string|null} sessionId  Optional session UUID; auto-detected if omitted.
 * @returns {{ sessionId, sessionDir, outputTokens, turnCount, textChars, toolCallChars }}
 */
function getSessionTokens(sessionId) {
    const sessionStateRoot = path.join(os.homedir(), '.copilot', 'session-state');

    let sessionDir;

    if (sessionId) {
        sessionDir = path.join(sessionStateRoot, sessionId);
        if (!fs.existsSync(sessionDir)) {
            throw new Error(`Session directory not found: ${sessionDir}`);
        }
    } else {
        // Find the most recently modified inuse.*.lock file across all session subdirs
        let latestLock = null;
        let latestTime = 0;

        try {
            const entries = fs.readdirSync(sessionStateRoot, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const subDir = path.join(sessionStateRoot, entry.name);
                try {
                    for (const file of fs.readdirSync(subDir)) {
                        if (/^inuse\..+\.lock$/.test(file)) {
                            const lockPath = path.join(subDir, file);
                            const mtime = fs.statSync(lockPath).mtimeMs;
                            if (mtime > latestTime) { latestTime = mtime; latestLock = lockPath; }
                        }
                    }
                } catch { /* skip unreadable dirs */ }
            }
        } catch (e) {
            throw new Error(`Failed to scan session state directory: ${e.message}`);
        }

        if (!latestLock) {
            throw new Error("No active Copilot CLI session found. Is 'copilot' running?");
        }

        sessionDir = path.dirname(latestLock);
        sessionId  = path.basename(sessionDir);
    }

    // Parse events.jsonl
    const eventsFile = path.join(sessionDir, 'events.jsonl');
    if (!fs.existsSync(eventsFile)) {
        throw new Error(`events.jsonl not found at: ${eventsFile}`);
    }

    const events = fs.readFileSync(eventsFile, 'utf8')
        .split('\n')
        .filter(l => l.trim())
        .flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });

    const { tokensByModel, outputTokens, turnCount, usedActualTokens, avgLatencySec } =
        accumulateTokens(events);

    return {
        sessionId,
        sessionDir,
        tokensByModel,
        outputTokens,
        turnCount,
        usedActualTokens,
        avgLatencySec,
    };
}

/**
 * Aggregates output tokens across all sessions that have events within [since, until].
 * @param {{ since?: Date|null, until?: Date|null }} options
 * @returns {{ tokensByModel, outputTokens, turnCount, sessionCount, usedActualTokens, avgLatencySec, since, until }}
 */
function getTokensForPeriod({ since = null, until = null } = {}) {
    const sessionStateRoot = path.join(os.homedir(), '.copilot', 'session-state');

    let entries;
    try {
        entries = fs.readdirSync(sessionStateRoot, { withFileTypes: true });
    } catch (e) {
        throw new Error(`Failed to scan session state directory: ${e.message}`);
    }

    const totalTokensByModel = {};
    let totalTurnCount       = 0;
    let sessionCount         = 0;
    let usedActualTokens     = false;
    const allLatencies       = [];

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const sessionDir = path.join(sessionStateRoot, entry.name);
        const eventsFile = path.join(sessionDir, 'events.jsonl');
        if (!fs.existsSync(eventsFile)) continue;

        let events;
        try {
            events = fs.readFileSync(eventsFile, 'utf8')
                .split('\n')
                .filter(l => l.trim())
                .flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
        } catch { continue; }

        // Only include events whose timestamp falls within the requested window.
        const inRange = events.filter(e => {
            if (!e.timestamp) return false;
            const t = new Date(e.timestamp);
            if (since && t < since) return false;
            if (until && t > until) return false;
            return true;
        });

        if (inRange.length === 0) continue;

        const acc = accumulateTokens(inRange);
        if (acc.outputTokens === 0 && acc.turnCount === 0) continue;

        for (const [model, tokens] of Object.entries(acc.tokensByModel)) {
            totalTokensByModel[model] = (totalTokensByModel[model] || 0) + tokens;
        }
        totalTurnCount += acc.turnCount;
        if (acc.usedActualTokens) usedActualTokens = true;
        if (acc.avgLatencySec != null) allLatencies.push(acc.avgLatencySec);
        sessionCount++;
    }

    const totalOutputTokens = Object.values(totalTokensByModel).reduce((a, b) => a + b, 0);
    const avgLatencySec = allLatencies.length > 0
        ? allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length
        : null;

    return {
        tokensByModel: totalTokensByModel,
        outputTokens:  totalOutputTokens,
        turnCount:     totalTurnCount,
        sessionCount,
        usedActualTokens,
        avgLatencySec,
        since,
        until,
    };
}

// Runnable standalone: node get-session-tokens.js [--SessionId <uuid>]
if (require.main === module) {
    const args   = process.argv.slice(2);
    const sidIdx = args.findIndex(a => /^--?SessionId$/i.test(a));
    const sessionId = sidIdx >= 0 ? (args[sidIdx].includes('=') ? args[sidIdx].split('=')[1] : args[sidIdx + 1]) : null;
    try {
        console.log(JSON.stringify(getSessionTokens(sessionId)));
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    }
}

module.exports = { getSessionTokens, getTokensForPeriod, accumulateTokens };
