# RiskPilot - AI Project Risk Copilot

AI-assisted project management: an LLM agent drafts project plans, a Gradient Boosting model predicts
which tasks will be late, and the app turns that into a critical-path schedule, earned-value cost control,
explained mitigations, Monte Carlo go-live forecasts and an AI copilot that writes status reports.

## Run locally
    npm install
    npm run dev

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
- `src/views.jsx` - dashboard views
