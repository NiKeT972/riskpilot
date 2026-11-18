# RiskPilot - AI Project Risk Copilot

**Live demo:** https://riskpilot-three.vercel.app

AI-assisted project management: an LLM agent drafts project plans, a Gradient Boosting model predicts
which tasks will be late, and the app turns that into a critical-path schedule, earned-value cost control,
explained mitigations, Monte Carlo go-live forecasts and an AI copilot that writes status reports.

[![ci](https://github.com/NiKeT972/riskpilot/actions/workflows/ci.yml/badge.svg)](https://github.com/NiKeT972/riskpilot/actions/workflows/ci.yml)

## Run locally
    npm install
    npm run dev
    npm test          # 32 tests (Vitest): CPM, EVM, Monte Carlo, the ML model, the planner, the API

## Deploy
Deploy to Vercel (framework: Vite). Optional: set `GROQ_API_KEY` (and `GROQ_MODEL`) in
Vercel -> Settings -> Environment Variables to enable the LLM planner/copilot. Without it the
built-in planner and analyst are used.

## Retrain the model
    pip install scikit-learn pandas numpy
    python ml/train_model.py      # writes src/model/model.json

## Structure
- `ml/train_model.py` - data generation, training, evaluation, JSON export
- `src/lib/ml.js` - in-browser inference + counterfactual explanations
- `src/lib/engine.js` - CPM, EVM, status-aware forecast, Monte Carlo
- `src/lib/agent.js` - LLM agent client + built-in planner/copilot fallback
- `api/agent.js` - Vercel serverless function calling Groq
- `src/lib/plan.js` - validates and cleans any task plan (clamps fields, drops unknown dependencies, breaks cycles)
- `src/views.jsx` - dashboard views
- `tests/` - Vitest suite; `.github/workflows/ci.yml` runs it and the build on every push

## Testing and reliability
- **Scheduling maths is checked against a network worked out by hand:** CPM early/late dates and slack, the status-aware forecast, EVM formulas (CPI = EV/AC, SPI = EV/PV, EAC = BAC/CPI) on every sample project, and Monte Carlo reproducibility (same seed → same P50/P80; mitigation never makes P80 worse).
- **Model sanity checks:** a clearly risky task scores above 80% and a healthy one below 35%, each risk factor pushes in the expected direction, and every counterfactual step lowers P(delay).
- **LLM plans are never trusted as-is.** `sanitizePlan()` runs on the server and again in the browser: numbers are clamped to the ranges the model was trained on, unknown dependencies are dropped, dependency cycles are broken (CPM needs a DAG), and the planner tells you what it fixed.
- **Bugs the tests found:** (1) the API tried `llama-3.3-70b-versatile` first, but Groq retired it on 16 Aug 2026, so every LLM call made a failing request first. `openai/gpt-oss-120b` is now the default. (2) For a near-certain delay (P ≈ 99.9%), no single fix moved the probability by a full point, so the riskiest tasks got no explanation. Explanations now also count a fix that clearly lowers the odds (log-odds), which doesn't flatten out near 100%.
