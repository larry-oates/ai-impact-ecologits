# ai-impact-ecologits

> Estimates the environmental impact of AI/LLM sessions using the [EcoLogits API](https://ecologits.ai).  
> Auto-detects GitHub Copilot CLI session tokens, or accepts manual token counts for any LLM tool.

---

## What it does

Ask the agent about the environmental cost of your current session (or any time window) and it will report:

- ⚡ **Energy use** (kWh range)
- 🌱 **CO₂ equivalent** (GWP range)
- 🚗 **Car distance equivalent** (configurable for your vehicle and region)
- 💻 **Workstation energy** (based on your machine's wattage)
- 📊 **Per-model breakdown** when multiple models were used

Works with **Claude, GPT, and any model in the map** — across single sessions or aggregated over days/date ranges.

---

## Installation

This is a skill for [GitHub Copilot CLI](https://githubnext.com/projects/copilot-cli). Install it with:

```bash
gh copilot skill install https://github.com/larry-oates/ai-impact-ecologits
```

Or using `npx skills`:

```bash
npx skills add larry-oates/ai-impact-ecologits
```

No other dependencies required — Node.js is bundled with Copilot CLI.

---

## Usage

Once installed, just ask Copilot CLI naturally:

> *"What's the environmental impact of this session?"*  
> *"How much CO₂ has my AI usage generated this week?"*  
> *"Estimate the carbon footprint of this session for a user in Germany."*

The skill triggers automatically on questions about environmental impact, carbon footprint, energy usage, CO₂ emissions, sustainability, or ecological cost.

---

## Manual use

You can also run the script directly:

```bash
# Current Copilot CLI session (auto-detected)
node "./run-impact.js"

# Any LLM tool — pass your output token count manually
node "./run-impact.js" --Model gpt-5.4 --OutputTokens 1500
node "./run-impact.js" --Model claude-sonnet-4.6 --OutputTokens 800
```

---

## Options

### Time period

| Parameter | Example | Description |
|---|---|---|
| `--Days` | `--Days 7` | Last N days (rolling window) |
| `--Since` | `--Since 2025-04-01` | From this date to now |
| `--Until` | `--Until 2025-04-30` | Up to this date |

Combine `--Since` and `--Until` for a precise date range:

```bash
node "./run-impact.js" --Since 2025-04-01 --Until 2025-04-30
```

### Regional & vehicle settings

| Parameter | Default | Description |
|---|---|---|
| `--Zone` | `WOR` | Electricity mix — ISO 3166-1 alpha-3 country code or `WOR` (world average). E.g. `USA`, `DEU`, `FRA`, `GBR`, `AUS`, `JPN`, `IND`, `BRA`. [Full list](https://api.ecologits.ai/v1beta/electricity-mix-zones) |
| `--CarEfficiency` | `40` | Your car's fuel efficiency (unit set by `--CarUnit`) |
| `--CarUnit` | `mpg-uk` | `mpg-uk` · `mpg-us` · `kpl` · `l100km` |
| `--FuelType` | `Diesel` | `Diesel`, `Petrol`, or `Gasoline` |
| `--WorkstationWatts` | `150` | Workstation power draw in watts |

#### Examples by region

```bash
# USA
node "./run-impact.js" --Zone USA --CarEfficiency 30 --CarUnit mpg-us --FuelType Gasoline

# Europe (Germany)
node "./run-impact.js" --Zone DEU --CarEfficiency 6.5 --CarUnit l100km

# Australia
node "./run-impact.js" --Zone AUS --CarEfficiency 12 --CarUnit kpl

# UK
node "./run-impact.js" --Zone GBR --CarEfficiency 40 --CarUnit mpg-uk
```

### Other options

| Parameter | Default | Description |
|---|---|---|
| `--Model` | auto | Override the model name used for impact calculation |
| `--OutputTokens` | — | Skip session auto-detection; use this token count directly |
| `--SessionId` | auto | Override the auto-detected session UUID |

---

## Supported models

`model-map.json` maps model names to EcoLogits identifiers. 181 models are mapped across four providers:

| Provider | Examples |
|---|---|
| **Anthropic** | `claude-sonnet-4.6`, `claude-opus-4.6`, `claude-haiku-4.5`, `claude-3-haiku-20240307`, dated variants |
| **OpenAI** | `gpt-5.4`, `gpt-5.2`, `gpt-4.1`, `gpt-4o`, `gpt-4-turbo`, `gpt-3.5-turbo`, `o1`, `o3-mini`, `o4-mini`, dated variants |
| **Mistral AI** | `mistral-large-latest`, `mistral-medium-latest`, `codestral-latest`, `devstral-latest`, `magistral-small-latest`, `pixtral-large-latest`, `voxtral-mini-latest`, and more |
| **Cohere** | `command-r`, `command-a-03-2025`, `c4ai-aya-expanse-32b`, and more |

For Copilot CLI models the map translates dot-notation names (e.g. `claude-sonnet-4.6`) to the EcoLogits dash-notation equivalent. For all other tools, pass the model name exactly as it appears in the EcoLogits API.

### Adding a model

If the script warns that a model isn't found, add it to `model-map.json`:

```json
{ "copilot_model": "your-model-name", "provider": "anthropic", "ecologits_model": "ecologits-name" }
```

Check available EcoLogits model names at:  
`https://api.ecologits.ai/v1beta/models/{provider}`

---

## Powered by

- [EcoLogits](https://ecologits.ai) — environmental impact estimates for LLM inference
- [GitHub Copilot CLI](https://githubnext.com/projects/copilot-cli)

---

## License

MIT
