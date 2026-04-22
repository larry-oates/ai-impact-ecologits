---
name: ai-impact-ecologits
description: Estimates the environmental impact of an LLM session using the EcoLogits API. Works with Copilot CLI (auto-detects session tokens) or any other LLM tool (pass token count manually). Use this skill when the user asks about environmental impact, carbon footprint, energy usage, CO2 emissions, sustainability, or the ecological cost of an AI session.
allowed-tools: shell
license: MIT
---

## EcoLogits Impact Estimator

### Usage

```bash
# Works on Windows, Linux, and macOS (Node.js is bundled with Copilot CLI)
node "./run-impact.js" 
```

show the user the output from the script verbatum then only provide a minimum unbiased summary

### Manual mode — any LLM tool

If you're not using Copilot CLI, pass your token count directly. Get the output token count from your tool's usage stats (ChatGPT, Claude.ai, Gemini, etc.):

```bash
# ChatGPT / OpenAI
node "./run-impact.js" --Model gpt-5.4 --OutputTokens 1500

# Claude (Anthropic)
node "./run-impact.js" --Model claude-sonnet-4.6 --OutputTokens 800

# Any model in the map
node "./run-impact.js" --Model <model-name> --OutputTokens <n>
```

When `--OutputTokens` is provided, session auto-detection is skipped entirely.

### Optional overrides

| Parameter | Default | Description |
|---|---|---|
| `--Zone` | `WOR` | Electricity mix zone — ISO 3166-1 alpha-3 country code or `WOR` (world average). Examples: `USA`, `DEU`, `FRA`, `AUS`, `JPN`, `GBR`, `IND`, `BRA`. Full list: `https://api.ecologits.ai/v1beta/electricity-mix-zones` |
| `--CarEfficiency` | `40` | Your car's fuel efficiency value (unit set by `--CarUnit`) |
| `--CarUnit` | `mpg-uk` | Unit for `--CarEfficiency`: `mpg-uk` (UK mpg), `mpg-us` (US mpg), `kpl` (km/L), `l100km` (L/100km) |
| `--FuelType` | `Diesel` | `Diesel`, `Petrol`, or `Gasoline` |
| `--WorkstationWatts` | `150` | Your workstation power draw in watts |
| `--SessionId` | auto | Override the session UUID if needed |

#### Examples by region

```bash
# USA — US electricity mix, US mpg
node "./run-impact.js" --Zone USA --CarEfficiency 30 --CarUnit mpg-us --FuelType Gasoline

# Europe — metric fuel economy (L/100km)
node "./run-impact.js" --Zone DEU --CarEfficiency 6.5 --CarUnit l100km

# Australia — km/L
node "./run-impact.js" --Zone AUS --CarEfficiency 12 --CarUnit kpl

# UK — UK mpg (legacy default)
node "./run-impact.js" --Zone GBR --CarEfficiency 40 --CarUnit mpg-uk
```

### Aggregate impact over a time period

To estimate the combined impact of **all sessions** within a window, add one of:

| Parameter | Example | Description |
|---|---|---|
| `--Days` | `--Days 7` | Last N days (rolling window ending now) |
| `--Since` | `--Since 2025-04-01` | From this date (inclusive) to now |
| `--Until` | `--Until 2025-04-30` | Up to this date (inclusive) |

Combine `--Since` and `--Until` for a precise date range:

```bash
node "./run-impact.js" --Since 2025-04-01 --Until 2025-04-30
```

### Model not in the map?

If the script warns that a model isn't found, add it to `model-map.json` in this skill's directory.
Check available EcoLogits model names at: `https://api.ecologits.ai/v1beta/models/{provider}`

